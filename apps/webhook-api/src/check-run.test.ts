import { describe, expect, test } from "bun:test";

import {
  cancelOrphanedCheckRun,
  createPendingCheckRun,
} from "./index";
import type { WebhookApiConfig } from "./index";

import type { GitHubPullRequestWebhookEvent } from "@mergewise/shared-types";

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
