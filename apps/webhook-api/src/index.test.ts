import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAnalyzePullRequestJob,
  buildCollectFeedbackJob,
  buildIndexRepoJob,
  computeGitHubSignature,
  isClosedOrMergedPullRequest,
  isDefaultBranchPush,
  isDraftPullRequest,
  isPullRequestWebhookEvent,
  isPushWebhookEvent,
  isWebhookSignatureValid,
  loadConfig,
  SUPPORTED_PULL_REQUEST_ACTIONS,
} from "./index";

import type { GitHubPullRequestWebhookEvent } from "@mergewise/shared-types";
import {
  toInstallationId,
  toPRNumber,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";

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
    pull_request: { number: 1, head: { sha: "a".repeat(40) } },
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
  const payload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: toRepoFullName("acme/widget") },
    pull_request: { number: toPRNumber(5), head: { sha: toSHA("d".repeat(40)) } },
    installation: { id: toInstallationId(99) },
  };

  test("maps fields from webhook event", () => {
    const job = buildAnalyzePullRequestJob(payload, "trace-123");
    expect(job.repo_full_name).toBe(toRepoFullName("acme/widget"));
    expect(job.pr_number).toBe(toPRNumber(5));
    expect(job.head_sha).toBe(toSHA("d".repeat(40)));
    expect(job.installation_id).toBe(toInstallationId(99));
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
    repository: { full_name: toRepoFullName("acme/widget") },
    pull_request: { number: toPRNumber(5), head: { sha: toSHA("d".repeat(40)) } },
    installation: { id: toInstallationId(99) },
  };

  test("maps fields from webhook event", () => {
    const job = buildCollectFeedbackJob(payload, "trace-456");
    expect(job.type).toBe("collect-feedback");
    expect(job.repo_full_name).toBe(toRepoFullName("acme/widget"));
    expect(job.pr_number).toBe(toPRNumber(5));
    expect(job.installation_id).toBe(toInstallationId(99));
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
    process.env["WEBHOOK_PORT"] = originalEnv["WEBHOOK_PORT"];
    process.env["GITHUB_WEBHOOK_SECRET"] = originalEnv["GITHUB_WEBHOOK_SECRET"];
    process.env["GITHUB_APP_ID"] = originalEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = originalEnv["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = originalEnv["GITHUB_APP_PRIVATE_KEY_PATH"];
  });

  test("returns default port when env is unset", () => {
    delete process.env["WEBHOOK_PORT"];
    delete process.env["GITHUB_WEBHOOK_SECRET"];
    delete process.env["GITHUB_APP_ID"];
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.webhookSecret).toBeUndefined();
    expect(cfg.githubAppId).toBeUndefined();
    expect(cfg.githubAppPrivateKeyPem).toBeUndefined();
  });

  test("reads webhook secret from env", () => {
    delete process.env["WEBHOOK_PORT"];
    process.env["GITHUB_WEBHOOK_SECRET"] = "test-secret";
    const cfg = loadConfig();
    expect(cfg.webhookSecret).toBe("test-secret");
  });

  test("reads and normalises GitHub App credentials from env", () => {
    delete process.env["WEBHOOK_PORT"];
    process.env["GITHUB_APP_ID"] = "456";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "-----BEGIN KEY-----\\nabc\\n-----END KEY-----\\n";
    const cfg = loadConfig();
    expect(cfg.githubAppId).toBe(456);
    expect(cfg.githubAppPrivateKeyPem).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  test("throws for invalid port", () => {
    process.env["WEBHOOK_PORT"] = "not-a-number";
    expect(() => loadConfig()).toThrow("Invalid WEBHOOK_PORT value");
  });

  test("reads private key from GITHUB_APP_PRIVATE_KEY_PATH when inline key is unset", () => {
    delete process.env["WEBHOOK_PORT"];
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    const tempDir = mkdtempSync(join(tmpdir(), "webhook-api-test-"));
    const keyPath = join(tempDir, "test.pem");
    writeFileSync(keyPath, "-----BEGIN RSA PRIVATE KEY-----\ntest-key-data\n-----END RSA PRIVATE KEY-----\n");

    try {
      process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = keyPath;
      process.env["GITHUB_APP_ID"] = "789";
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
    delete process.env["WEBHOOK_PORT"];
    const tempDir = mkdtempSync(join(tmpdir(), "webhook-api-test-"));
    const keyPath = join(tempDir, "test.pem");
    writeFileSync(keyPath, "file-key-content");

    try {
      process.env["GITHUB_APP_PRIVATE_KEY"] = "inline-key-content";
      process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = keyPath;
      const cfg = loadConfig();
      expect(cfg.githubAppPrivateKeyPem).toBe("inline-key-content");
    } finally {
      unlinkSync(keyPath);
    }
  });

  test("returns undefined when GITHUB_APP_PRIVATE_KEY_PATH file is unreadable", () => {
    delete process.env["WEBHOOK_PORT"];
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = "/nonexistent/path/key.pem";
    const cfg = loadConfig();
    expect(cfg.githubAppPrivateKeyPem).toBeUndefined();
  });
});

describe("isDraftPullRequest", () => {
  const basePayload: GitHubPullRequestWebhookEvent = {
    action: "opened",
    repository: { full_name: toRepoFullName("acme/widget") },
    pull_request: { number: toPRNumber(1), head: { sha: toSHA("a".repeat(40)) } },
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
    repository: { full_name: toRepoFullName("acme/widget") },
    pull_request: { number: toPRNumber(1), head: { sha: toSHA("a".repeat(40)) }, state: "open", merged: false },
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
      repository: { full_name: toRepoFullName("acme/widget") },
      pull_request: { number: toPRNumber(1), head: { sha: toSHA("a".repeat(40)) } },
    };
    expect(isClosedOrMergedPullRequest(payload)).toBe(false);
  });
});

describe("isPushWebhookEvent", () => {
  const validPayload = {
    ref: "refs/heads/main",
    after: "abc123def456",
    repository: {
      full_name: "owner/repo",
      default_branch: "main",
    },
    installation: { id: 12345 },
  };

  test("accepts valid push payload with all required fields", () => {
    expect(isPushWebhookEvent(validPayload)).toBe(true);
  });

  test("rejects null", () => {
    expect(isPushWebhookEvent(null)).toBe(false);
  });

  test("rejects undefined", () => {
    expect(isPushWebhookEvent(undefined)).toBe(false);
  });

  test("rejects payload missing ref", () => {
    const { ref: _, ...rest } = validPayload;
    expect(isPushWebhookEvent(rest)).toBe(false);
  });

  test("rejects payload missing after", () => {
    const { after: _, ...rest } = validPayload;
    expect(isPushWebhookEvent(rest)).toBe(false);
  });

  test("rejects payload missing repository.default_branch", () => {
    const payload = {
      ...validPayload,
      repository: { full_name: "owner/repo" },
    };
    expect(isPushWebhookEvent(payload)).toBe(false);
  });

  test("accepts payload with optional installation field", () => {
    const { installation: _, ...withoutInstallation } = validPayload;
    expect(isPushWebhookEvent(withoutInstallation)).toBe(true);
  });

  test("accepts payload with null installation", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: null })).toBe(true);
  });

  test("rejects payload with non-object installation", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: "string" })).toBe(false);
  });

  test("rejects installation.id of zero", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: 0 } })).toBe(false);
  });

  test("rejects negative installation.id", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: -1 } })).toBe(false);
  });

  test("rejects NaN installation.id", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: NaN } })).toBe(false);
  });

  test("rejects non-integer installation.id", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: 1.5 } })).toBe(false);
  });

  test("rejects installation.id exceeding MAX_SAFE_INTEGER", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: Number.MAX_SAFE_INTEGER + 1 } })).toBe(false);
  });

  test("accepts MAX_SAFE_INTEGER installation.id", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: Number.MAX_SAFE_INTEGER } })).toBe(true);
  });

  test("accepts valid positive integer installation.id", () => {
    expect(isPushWebhookEvent({ ...validPayload, installation: { id: 42 } })).toBe(true);
  });
});

describe("isDefaultBranchPush", () => {
  test("returns true when ref matches refs/heads/<default_branch>", () => {
    const payload = {
      ref: "refs/heads/main",
      after: "abc123",
      repository: { full_name: toRepoFullName("owner/repo"), default_branch: "main" },
    };
    expect(isDefaultBranchPush(payload)).toBe(true);
  });

  test("returns false for non-default branch push", () => {
    const payload = {
      ref: "refs/heads/feature-x",
      after: "abc123",
      repository: { full_name: toRepoFullName("owner/repo"), default_branch: "main" },
    };
    expect(isDefaultBranchPush(payload)).toBe(false);
  });

  test("returns false for tag refs", () => {
    const payload = {
      ref: "refs/tags/v1.0",
      after: "abc123",
      repository: { full_name: toRepoFullName("owner/repo"), default_branch: "main" },
    };
    expect(isDefaultBranchPush(payload)).toBe(false);
  });
});

describe("buildIndexRepoJob", () => {
  const payload = {
    ref: "refs/heads/main",
    after: "abc123def456",
    repository: {
      full_name: toRepoFullName("owner/repo"),
      default_branch: "main",
    },
    installation: { id: 12345 },
  };

  test("sets type to index-repo", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.type).toBe("index-repo");
  });

  test("maps repository.full_name to repo_full_name", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.repo_full_name).toBe(toRepoFullName("owner/repo"));
  });

  test("maps repository.default_branch to default_branch", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.default_branch).toBe("main");
  });

  test("maps after to head_sha", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.head_sha).toBe("abc123def456");
  });

  test("maps installation.id to installation_id", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.installation_id).toBe(12345);
  });

  test("sets installation_id to null when installation is absent", () => {
    const { installation: _, ...noInstall } = payload;
    const job = buildIndexRepoJob(noInstall, "trace-100");
    expect(job.installation_id).toBeNull();
  });

  test("includes traceId when provided", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.trace_id).toBe("trace-100");
  });

  test("produces valid UUID for job_id", () => {
    const job = buildIndexRepoJob(payload, "trace-100");
    expect(job.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

