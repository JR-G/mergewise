import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAnalyzePullRequestJob,
  buildCollectFeedbackJob,
  cancelOrphanedCheckRun,
  computeGitHubSignature,
  createPendingCheckRun,
  createWebhookErrorResponse,
  createWebhookJsonResponse,
  getRequestId,
  isClosedOrMergedPullRequest,
  isDraftPullRequest,
  isPullRequestWebhookEvent,
  isWebhookSignatureValid,
  loadConfig,
  logWebhookFailure,
  readWebhookRequestBody,
  SUPPORTED_PULL_REQUEST_ACTIONS,
} from "./index";
import type { WebhookApiConfig } from "./index";

import type { GitHubPullRequestWebhookEvent } from "@mergewise/shared-types";

describe("computeGitHubSignature", () => {
  test("produces deterministic sha256-prefixed hex", () => {
    const sig = computeGitHubSignature("payload", "secret");
    expect(sig).toStartWith("sha256=");

    const again = computeGitHubSignature("payload", "secret");
    expect(again).toBe(sig);
  });

  test("different payloads produce different signatures", () => {
    const sigA = computeGitHubSignature("aaa", "secret");
    const sigB = computeGitHubSignature("bbb", "secret");
    expect(sigA).not.toBe(sigB);
  });
});

describe("isWebhookSignatureValid", () => {
  test("returns true when no secret is configured", () => {
    expect(isWebhookSignatureValid("body", null, undefined)).toBe(true);
    expect(isWebhookSignatureValid("body", null, "")).toBe(true);
  });

  test("returns false when header is null but secret is set", () => {
    expect(isWebhookSignatureValid("body", null, "secret")).toBe(false);
  });

  test("returns true for valid signature", () => {
    const payload = '{"test": true}';
    const secret = "webhook-secret";
    const sig = computeGitHubSignature(payload, secret);
    expect(isWebhookSignatureValid(payload, sig, secret)).toBe(true);
  });

  test("returns false for invalid signature", () => {
    expect(isWebhookSignatureValid("body", "sha256=wrong", "secret")).toBe(false);
  });

  test("returns false for length mismatch", () => {
    expect(isWebhookSignatureValid("body", "sha256=ab", "secret")).toBe(false);
  });
});

describe("isPullRequestWebhookEvent", () => {
  const validPayload = {
    action: "opened",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 1, head: { sha: "abc123" } },
  };

  test("returns true for valid payload", () => {
    expect(isPullRequestWebhookEvent(validPayload)).toBe(true);
  });

  test("returns false for null", () => {
    expect(isPullRequestWebhookEvent(null)).toBe(false);
  });

  test("returns false for non-object", () => {
    expect(isPullRequestWebhookEvent("string")).toBe(false);
  });

  test("returns false for missing action", () => {
    const { action: _, ...rest } = validPayload;
    expect(isPullRequestWebhookEvent(rest)).toBe(false);
  });

  test("returns false for missing repository", () => {
    const { repository: _, ...rest } = validPayload;
    expect(isPullRequestWebhookEvent(rest)).toBe(false);
  });

  test("returns false for missing pull_request", () => {
    const { pull_request: _, ...rest } = validPayload;
    expect(isPullRequestWebhookEvent(rest)).toBe(false);
  });
});

describe("buildAnalyzePullRequestJob", () => {
  const payload = {
    action: "opened" as const,
    repository: { full_name: "acme/widget" },
    pull_request: { number: 5, head: { sha: "def456" } },
    installation: { id: 99 },
  };

  test("maps fields from webhook event", () => {
    const job = buildAnalyzePullRequestJob(payload, "trace-123");
    expect(job.repo_full_name).toBe("acme/widget");
    expect(job.pr_number).toBe(5);
    expect(job.head_sha).toBe("def456");
    expect(job.installation_id).toBe(99);
    expect(job.trace_id).toBe("trace-123");
  });

  test("produces valid UUID for job_id", () => {
    const job = buildAnalyzePullRequestJob(payload, "trace-123");
    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("handles null installation_id", () => {
    const { installation: _, ...noInstall } = payload;
    const job = buildAnalyzePullRequestJob(noInstall, "trace-123");
    expect(job.installation_id).toBeNull();
  });
});

describe("buildCollectFeedbackJob", () => {
  const payload: GitHubPullRequestWebhookEvent = {
    action: "closed",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 5, head: { sha: "def456" } },
    installation: { id: 99 },
  };

  test("maps fields from webhook event", () => {
    const job = buildCollectFeedbackJob(payload, "trace-456");
    expect(job.type).toBe("collect-feedback");
    expect(job.repo_full_name).toBe("acme/widget");
    expect(job.pr_number).toBe(5);
    expect(job.installation_id).toBe(99);
    expect(job.trace_id).toBe("trace-456");
  });

  test("produces valid UUID for job_id", () => {
    const job = buildCollectFeedbackJob(payload);
    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("handles null installation_id", () => {
    const { installation: _, ...noInstall } = payload;
    const job = buildCollectFeedbackJob(noInstall);
    expect(job.installation_id).toBeNull();
  });
});

describe("SUPPORTED_PULL_REQUEST_ACTIONS", () => {
  test("includes opened, reopened, synchronize", () => {
    expect(SUPPORTED_PULL_REQUEST_ACTIONS.has("opened")).toBe(true);
    expect(SUPPORTED_PULL_REQUEST_ACTIONS.has("reopened")).toBe(true);
    expect(SUPPORTED_PULL_REQUEST_ACTIONS.has("synchronize")).toBe(true);
  });

  test("excludes closed and other actions", () => {
    const actions = SUPPORTED_PULL_REQUEST_ACTIONS;
    expect(actions.has("closed")).toBe(false);
    expect(actions.has("edited")).toBe(false);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.WEBHOOK_PORT = originalEnv.WEBHOOK_PORT;
    process.env.GITHUB_WEBHOOK_SECRET = originalEnv.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_APP_ID = originalEnv.GITHUB_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY = originalEnv.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = originalEnv.GITHUB_APP_PRIVATE_KEY_PATH;
  });

  test("returns default port when env is unset", () => {
    delete process.env.WEBHOOK_PORT;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.webhookSecret).toBeUndefined();
    expect(cfg.githubAppId).toBeUndefined();
    expect(cfg.githubAppPrivateKeyPem).toBeUndefined();
  });

  test("reads webhook secret from env", () => {
    delete process.env.WEBHOOK_PORT;
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const cfg = loadConfig();
    expect(cfg.webhookSecret).toBe("test-secret");
  });

  test("reads and normalises GitHub App credentials from env", () => {
    delete process.env.WEBHOOK_PORT;
    process.env.GITHUB_APP_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN KEY-----\\nabc\\n-----END KEY-----\\n";
    const cfg = loadConfig();
    expect(cfg.githubAppId).toBe(456);
    expect(cfg.githubAppPrivateKeyPem).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  test("throws for invalid port", () => {
    process.env.WEBHOOK_PORT = "not-a-number";
    expect(() => loadConfig()).toThrow("Invalid WEBHOOK_PORT value");
  });

  test("reads private key from GITHUB_APP_PRIVATE_KEY_PATH when inline key is unset", () => {
    delete process.env.WEBHOOK_PORT;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    const tempDir = mkdtempSync(join(tmpdir(), "webhook-api-test-"));
    const keyPath = join(tempDir, "test.pem");
    writeFileSync(keyPath, "-----BEGIN RSA PRIVATE KEY-----\ntest-key-data\n-----END RSA PRIVATE KEY-----\n");

    try {
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
      process.env.GITHUB_APP_ID = "789";
      const cfg = loadConfig();
      expect(cfg.githubAppId).toBe(789);
      expect(cfg.githubAppPrivateKeyPem).toBe(
        "-----BEGIN RSA PRIVATE KEY-----\ntest-key-data\n-----END RSA PRIVATE KEY-----",
      );
    } finally {
      unlinkSync(keyPath);
    }
  });

  test("prefers GITHUB_APP_PRIVATE_KEY over GITHUB_APP_PRIVATE_KEY_PATH", () => {
    delete process.env.WEBHOOK_PORT;
    const tempDir = mkdtempSync(join(tmpdir(), "webhook-api-test-"));
    const keyPath = join(tempDir, "test.pem");
    writeFileSync(keyPath, "file-key-content");

    try {
      process.env.GITHUB_APP_PRIVATE_KEY = "inline-key-content";
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
      const cfg = loadConfig();
      expect(cfg.githubAppPrivateKeyPem).toBe("inline-key-content");
    } finally {
      unlinkSync(keyPath);
    }
  });

  test("returns undefined when GITHUB_APP_PRIVATE_KEY_PATH file is unreadable", () => {
    delete process.env.WEBHOOK_PORT;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/nonexistent/path/key.pem";
    const cfg = loadConfig();
    expect(cfg.githubAppPrivateKeyPem).toBeUndefined();
  });
});

describe("getRequestId", () => {
  test("uses existing x-request-id header", () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "x-request-id": "external-request-id",
      },
    });

    expect(getRequestId(request)).toBe("external-request-id");
  });

  test("generates uuid when header is missing", () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
    });

    expect(getRequestId(request)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("createWebhookJsonResponse", () => {
  test("propagates request id as response header", async () => {
    const response = createWebhookJsonResponse(
      { status: "ok", request_id: "test-request-id" },
      200,
      "test-request-id",
    );

    expect(response.headers.get("x-request-id")).toBe("test-request-id");
    expect(await response.json()).toEqual({
      status: "ok",
      request_id: "test-request-id",
    });
  });
});

describe("createWebhookErrorResponse", () => {
  test("returns standard error envelope", async () => {
    const response = createWebhookErrorResponse(
      "invalid_signature",
      "Invalid signature",
      401,
      "request-123",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(await response.json()).toEqual({
      status: "error",
      request_id: "request-123",
      error: {
        code: "invalid_signature",
        message: "Invalid signature",
      },
    });
  });
});

describe("readWebhookRequestBody", () => {
  test("returns raw body when request text succeeds", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      body: '{"ok":true}',
    });

    const result = await readWebhookRequestBody(
      request,
      "request-100",
      "pull_request",
    );

    expect(result).toEqual({
      ok: true,
      rawBody: '{"ok":true}',
    });
  });

  test("returns typed error response when request body read fails", async () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    const failingRequest = {
      text: async (): Promise<string> => {
        throw new Error("body stream failed");
      },
    } as unknown as Request;

    try {
      const result = await readWebhookRequestBody(
        failingRequest,
        "request-101",
        "pull_request",
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected request body read to fail");
      }

      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("x-request-id")).toBe("request-101");
      expect(await result.response.json()).toEqual({
        status: "error",
        request_id: "request-101",
        error: {
          code: "request_body_read_failed",
          message: "Failed to read request body",
        },
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toHaveLength(1);
    const loggedPayload = JSON.parse(String(capturedLogs[0])) as {
      error_code: string;
      message: string;
      request_id: string;
      github_event: string;
      cause: string;
    };
    expect(loggedPayload.error_code).toBe("request_body_read_failed");
    expect(loggedPayload.message).toBe("Failed to read request body");
    expect(loggedPayload.request_id).toBe("request-101");
    expect(loggedPayload.github_event).toBe("pull_request");
    expect(loggedPayload.cause).toContain("body stream failed");
  });
});

describe("logWebhookFailure", () => {
  test("emits structured json logs", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-456",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toBe(
      JSON.stringify({
        event: "webhook_request_failed",
        request_id: "request-456",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
      }),
    );
  });

  test("serializes canonical repository and pull request fields", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-789",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repository_full_name: "acme/widget",
        pull_request_number: 7,
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toBe(
      JSON.stringify({
        event: "webhook_request_failed",
        request_id: "request-789",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repository_full_name: "acme/widget",
        pull_request_number: 7,
        repo_full_name: "acme/widget",
        pr_number: 7,
      }),
    );
  });

  test("maps legacy aliases to canonical fields", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-790",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repo_full_name: "acme/legacy",
        pr_number: 13,
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toBe(
      JSON.stringify({
        event: "webhook_request_failed",
        request_id: "request-790",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repo_full_name: "acme/legacy",
        pr_number: 13,
        repository_full_name: "acme/legacy",
        pull_request_number: 13,
      }),
    );
  });
});

describe("isDraftPullRequest", () => {
  const basePayload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 1, head: { sha: "abc" } },
  };

  test("returns true when draft is true", () => {
    const payload = { ...basePayload, pull_request: { ...basePayload.pull_request, draft: true } };
    expect(isDraftPullRequest(payload)).toBe(true);
  });

  test("returns false when draft is false", () => {
    const payload = { ...basePayload, pull_request: { ...basePayload.pull_request, draft: false } };
    expect(isDraftPullRequest(payload)).toBe(false);
  });

  test("returns false when draft is undefined", () => {
    expect(isDraftPullRequest(basePayload)).toBe(false);
  });
});

describe("isClosedOrMergedPullRequest", () => {
  const basePayload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 1, head: { sha: "abc" }, state: "open", merged: false },
  };

  test("returns true when state is closed", () => {
    const payload = { ...basePayload, pull_request: { ...basePayload.pull_request, state: "closed" as const } };
    expect(isClosedOrMergedPullRequest(payload)).toBe(true);
  });

  test("returns true when merged is true", () => {
    const payload = { ...basePayload, pull_request: { ...basePayload.pull_request, merged: true } };
    expect(isClosedOrMergedPullRequest(payload)).toBe(true);
  });

  test("returns false for open non-merged PR", () => {
    expect(isClosedOrMergedPullRequest(basePayload)).toBe(false);
  });

  test("returns false when state and merged are undefined", () => {
    const payload: GitHubPullRequestWebhookEvent = {
      action: "opened",
      repository: { full_name: "acme/widget" },
      pull_request: { number: 1, head: { sha: "abc" } },
    };
    expect(isClosedOrMergedPullRequest(payload)).toBe(false);
  });
});

describe("createPendingCheckRun", () => {
  const payload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 1, head: { sha: "abc123" } },
    installation: { id: 99 },
  };

  test("returns null when app credentials are missing", async () => {
    const result = await createPendingCheckRun(payload, { port: 8787 });
    expect(result).toBeNull();
  });

  test("returns null when installation id is missing", async () => {
    const { installation: _, ...noInstall } = payload;
    const result = await createPendingCheckRun(noInstall, {
      port: 8787,
      githubAppId: 1,
      githubAppPrivateKeyPem: "pem",
    });
    expect(result).toBeNull();
  });

  test("returns check run id on success", async () => {
    const result = await createPendingCheckRun(
      payload,
      { port: 8787, githubAppId: 1, githubAppPrivateKeyPem: "pem" },
      {
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "tok",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        createCheckRunFn: async () => ({
          id: 77,
          html_url: "https://github.com/x",
          status: "queued" as const,
          conclusion: null,
        }),
      },
    );
    expect(result).toBe(77);
  });

  test("returns null when check run creation throws", async () => {
    const result = await createPendingCheckRun(
      payload,
      { port: 8787, githubAppId: 1, githubAppPrivateKeyPem: "pem" },
      {
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "tok",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        createCheckRunFn: async () => { throw new Error("API down"); },
      },
    );
    expect(result).toBeNull();
  });
});

describe("cancelOrphanedCheckRun", () => {
  const payload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: "acme/widget" },
    pull_request: { number: 1, head: { sha: "abc123" } },
    installation: { id: 99 },
  };

  const validConfig: WebhookApiConfig = {
    port: 8787,
    githubAppId: 123,
    githubAppPrivateKeyPem: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  };

  test("calls updateCheckRun with failure conclusion", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    await cancelOrphanedCheckRun(42, payload, validConfig, {
      createGitHubAppJwtFn: () => "fake-jwt",
      exchangeInstallationAccessTokenFn: async () => ({
        token: "install-token",
        expires_at: "2026-01-01T00:00:00Z",
      }),
      updateCheckRunFn: async (options) => {
        capturedOptions = options as unknown as Record<string, unknown>;
        return { id: 42, html_url: "https://github.com/x", status: "completed", conclusion: "failure" };
      },
    });

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.checkRunId).toBe(42);
    expect(capturedOptions?.status).toBe("completed");
    expect(capturedOptions?.conclusion).toBe("failure");
  });

  test("does nothing when app credentials are missing", async () => {
    let called = false;
    await cancelOrphanedCheckRun(42, payload, { port: 8787 }, {
      updateCheckRunFn: async () => {
        called = true;
        return { id: 42, html_url: "https://github.com/x", status: "completed", conclusion: "failure" };
      },
    });
    expect(called).toBe(false);
  });

  test("swallows errors without throwing", async () => {
    const originalConsoleError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      await cancelOrphanedCheckRun(42, payload, validConfig, {
        createGitHubAppJwtFn: () => "fake-jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "install-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        updateCheckRunFn: async () => { throw new Error("network failure"); },
      });
      expect(errors.some((msg) => String(msg).includes("network failure"))).toBe(true);
    } finally {
      console.error = originalConsoleError;
    }
  });
});
