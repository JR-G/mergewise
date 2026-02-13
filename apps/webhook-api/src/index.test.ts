import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAnalyzePullRequestJob,
  computeGitHubSignature,
  createWebhookErrorResponse,
  createWebhookJsonResponse,
  getRequestId,
  isPullRequestWebhookEvent,
  isWebhookSignatureValid,
  loadConfig,
  logWebhookFailure,
  SUPPORTED_PULL_REQUEST_ACTIONS,
} from "./index";

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
    const job = buildAnalyzePullRequestJob(payload);
    expect(job.repo_full_name).toBe("acme/widget");
    expect(job.pr_number).toBe(5);
    expect(job.head_sha).toBe("def456");
    expect(job.installation_id).toBe(99);
  });

  test("produces valid UUID for job_id", () => {
    const job = buildAnalyzePullRequestJob(payload);
    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("handles null installation_id", () => {
    const { installation: _, ...noInstall } = payload;
    const job = buildAnalyzePullRequestJob(noInstall);
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
    const actions = SUPPORTED_PULL_REQUEST_ACTIONS as ReadonlySet<string>;
    expect(actions.has("closed")).toBe(false);
    expect(actions.has("edited")).toBe(false);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.WEBHOOK_PORT = originalEnv.WEBHOOK_PORT;
    process.env.GITHUB_WEBHOOK_SECRET = originalEnv.GITHUB_WEBHOOK_SECRET;
  });

  test("returns default port when env is unset", () => {
    delete process.env.WEBHOOK_PORT;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.webhookSecret).toBeUndefined();
  });

  test("reads webhook secret from env", () => {
    delete process.env.WEBHOOK_PORT;
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const cfg = loadConfig();
    expect(cfg.webhookSecret).toBe("test-secret");
  });

  test("throws for invalid port", () => {
    process.env.WEBHOOK_PORT = "not-a-number";
    expect(() => loadConfig()).toThrow("Invalid WEBHOOK_PORT value");
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
