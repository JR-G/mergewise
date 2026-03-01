import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubApiError } from "@mergewise/github-client";
import type { CreatePullRequestReviewOptions } from "@mergewise/github-client";

import { processAnalyzePullRequestJob } from "./index";
import {
  createFinding,
  createRule,
  openPullRequestState,
  workerFetchOptions,
  ZERO_REACTIONS,
} from "./test-helpers";

describe("processAnalyzePullRequestJob", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("successful fetch feeds rule execution and returns deterministic summary", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const capturedContexts: unknown[] = [];

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-2",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 50,
        head_sha: "def456",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,1 +1,2 @@\n-const a = 1;\n+const value = 1;\n+const b = 2;",
          },
        ],
        executeRulesFn: async ({ context }) => {
          capturedContexts.push(context);
          return {
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: {
                clean: 0,
                perf: 0,
                safety: 0,
                idiomatic: 0,
              },
            },
            failedRuleIds: [],
          };
        },
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );

    const analysisContext = capturedContexts[0] as {
      diffs: { filePath: string; hunks: { header: string; lines: string[] }[] }[];
    };

    expect(analysisContext.diffs[0]).toBeDefined();
    expect(analysisContext.diffs[0]?.filePath).toBe("src/index.ts");
    expect(analysisContext.diffs[0]?.hunks[0]?.header).toBe("@@ -1,1 +1,2 @@");
    expect(analysisContext.diffs[0]?.hunks[0]?.lines).toEqual([
      "-const a = 1;",
      "+const value = 1;",
      "+const b = 2;",
    ]);
    expect(summary.jobId).toBe("job-2");
    expect(summary.idempotencyKey).toBe("acme/widget#50@def456");
    expect(summary.traceId).toBe("job-2");
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(summary.checkOutput?.title).toContain("Review completed");
  });

  test("non-retryable GitHub fetch failure is surfaced", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        {
          job_id: "job-3",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 51,
          head_sha: "def457",
          queued_at: "2025-01-01T00:00:00Z",
        },
        {
          githubFetchOptions: workerFetchOptions,
          fetchPullRequestFn: async () => openPullRequestState,
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "installation-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => {
            throw new GitHubApiError(404, "GET", "https://api.github.com/x", "missing");
          },
        },
      );
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(GitHubApiError);
  });

  test("supports legacy GITHUB_APP_PRIVATE_KEY_PEM when new key name is unset", async () => {
    process.env.GITHUB_APP_ID = "123";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY_PEM = "legacy-private-key";

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-legacy-key",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 52,
        head_sha: "def458",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: {
              clean: 0,
              perf: 0,
              safety: 0,
              idiomatic: 0,
            },
          },
          failedRuleIds: [],
        }),
      },
    );

    expect(summary.jobId).toBe("job-legacy-key");
    expect(summary.traceId).toBe("job-legacy-key");
  });

  test("supports GITHUB_APP_PRIVATE_KEY_PATH when inline key vars are unset", async () => {
    process.env.GITHUB_APP_ID = "123";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PEM;

    const temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "mergewise-worker-test-"));
    const privateKeyPath = join(temporaryDirectoryPath, "private-key.pem");
    writeFileSync(privateKeyPath, "path-private-key\n");
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = privateKeyPath;

    try {
      const summary = await processAnalyzePullRequestJob(
        {
          job_id: "job-path-key",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 52,
          head_sha: "def458",
          queued_at: "2025-01-01T00:00:00Z",
        },
        {
          githubFetchOptions: workerFetchOptions,
          rules: [],
          fetchPullRequestFn: async () => openPullRequestState,
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "installation-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => [],
          executeRulesFn: async () => ({
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: {
                clean: 0,
                perf: 0,
                safety: 0,
                idiomatic: 0,
              },
            },
            failedRuleIds: [],
          }),
        },
      );

      expect(summary.jobId).toBe("job-path-key");
    } finally {
      rmSync(temporaryDirectoryPath, { recursive: true, force: true });
      delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    }
  });

  test("invalid GITHUB_APP_PRIVATE_KEY_PATH surfaces explicit error", async () => {
    process.env.GITHUB_APP_ID = "123";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PEM;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/tmp/mergewise-missing-private-key.pem";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        {
          job_id: "job-invalid-path-key",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 53,
          head_sha: "def459",
          queued_at: "2025-01-01T00:00:00Z",
        },
        {
          githubFetchOptions: workerFetchOptions,
          rules: [],
          fetchPullRequestFn: async () => openPullRequestState,
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "installation-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => [],
          executeRulesFn: async () => ({
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: {
                clean: 0,
                perf: 0,
                safety: 0,
                idiomatic: 0,
              },
            },
            failedRuleIds: [],
          }),
        },
      );
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain("[worker] failed to read GITHUB_APP_PRIVATE_KEY_PATH");

    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  });

  test("invalid GITHUB_APP_ID surfaces explicit error", async () => {
    process.env.GITHUB_APP_ID = "not-a-number";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        {
          job_id: "job-invalid-app-id",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 53,
          head_sha: "def459",
          queued_at: "2025-01-01T00:00:00Z",
        },
        {
          githubFetchOptions: workerFetchOptions,
          rules: [],
          fetchPullRequestFn: async () => openPullRequestState,
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "installation-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => [],
          executeRulesFn: async () => ({
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: {
                clean: 0,
                perf: 0,
                safety: 0,
                idiomatic: 0,
              },
            },
            failedRuleIds: [],
          }),
        },
      );
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain("[worker] invalid GITHUB_APP_ID value: not-a-number");
  });

  test("applies config-driven rule include/exclude selection", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const capturedRuleIds: string[][] = [];
    const rules = [createRule("rule-a"), createRule("rule-b"), createRule("rule-c")];

    await processAnalyzePullRequestJob(
      {
        job_id: "job-rule-selection",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 54,
        head_sha: "def460",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules,
        fetchPullRequestFn: async () => openPullRequestState,
        mergewiseConfig: {
          gating: {
            confidenceThreshold: 0,
            maxComments: 20,
          },
          rules: {
            include: ["rule-a", "rule-c"],
            exclude: ["rule-c"],
          },
          review: { skipPatterns: [] },
          llm: {
            enabled: false,
            model: "gpt-4o",
            tokenBudget: 30_000,
            baseUrl: "https://api.openai.com/v1",
            consistencySamples: 1,
          },
        },
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async ({ rules: selectedRules }) => {
          capturedRuleIds.push(selectedRules.map((rule) => rule.metadata.ruleId));
          return {
            findings: [],
            summary: {
              totalRules: selectedRules.length,
              successfulRules: selectedRules.length,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: {
                clean: 0,
                perf: 0,
                safety: 0,
                idiomatic: 0,
              },
            },
            failedRuleIds: [],
          };
        },
      },
    );

    expect(capturedRuleIds.flat()).toContain("rule-a");
    expect(capturedRuleIds.flat()).not.toContain("rule-b");
    expect(capturedRuleIds.flat()).not.toContain("rule-c");
  });

  test("applies confidence gating to execution summary and delivery cap separately", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-gating",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 55,
        head_sha: "def461",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        fetchPullRequestFn: async () => openPullRequestState,
        mergewiseConfig: {
          gating: {
            confidenceThreshold: 0.8,
            maxComments: 2,
          },
          rules: {
            include: [],
            exclude: [],
          },
          review: { skipPatterns: [] },
          llm: {
            enabled: false,
            model: "gpt-4o",
            tokenBudget: 30_000,
            baseUrl: "https://api.openai.com/v1",
            consistencySamples: 1,
          },
        },
        rules: [],
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [
            createFinding("finding-low", 0.79, "clean"),
            createFinding("finding-high-1", 0.95, "perf"),
            createFinding("finding-high-2", 0.8, "safety"),
            createFinding("finding-high-3", 0.99, "idiomatic"),
          ],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 4,
            findingsByCategory: {
              clean: 1,
              perf: 1,
              safety: 1,
              idiomatic: 1,
            },
          },
          failedRuleIds: [],
        }),
      },
    );

    expect(summary.totalFindings).toBeLessThan(4);
    expect(summary.traceId).toBe("job-gating");
    expect(summary.checkOutput?.title).toBe("Review completed");
  });

  test("creates in-progress check run then updates to completed when deliveryMode is github", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let capturedInProgressCreate: Record<string, unknown> | null = null;
    let capturedCompletedUpdate: Record<string, unknown> | null = null;
    await processAnalyzePullRequestJob(
      {
        job_id: "job-check",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 60,
        head_sha: "check123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        createPullRequestReviewFn: async () => ({
          id: 1, html_url: "https://github.com/x", body: null, state: "commented",
        }),
        createCheckRunFn: async (options) => {
          capturedInProgressCreate = {
            owner: options.owner,
            repository: options.repository,
            headSha: options.headSha,
            name: options.name,
            status: options.status,
          };
          return { id: 42, html_url: "https://github.com/x", status: "in_progress", conclusion: null };
        },
        updateCheckRunFn: async (options) => {
          capturedCompletedUpdate = {
            owner: options.owner,
            repository: options.repository,
            checkRunId: options.checkRunId,
            status: options.status,
            conclusion: options.conclusion,
          };
          return { id: 42, html_url: "https://github.com/x", status: "completed", conclusion: "success" };
        },
      },
    );

    expect(capturedInProgressCreate).not.toBeNull();
    expect(capturedInProgressCreate!.owner).toBe("acme");
    expect(capturedInProgressCreate!.name).toBe("Mergewise");
    expect(capturedInProgressCreate!.status).toBe("in_progress");
    expect(capturedCompletedUpdate).not.toBeNull();
    expect(capturedCompletedUpdate!.checkRunId).toBe(42);
    expect(capturedCompletedUpdate!.status).toBe("completed");
    expect(capturedCompletedUpdate!.conclusion).toBe("success");
  });

  test("updates existing check run instead of creating when check_run_id is present on job", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let createCheckRunCalled = false;
    const capturedUpdates: Record<string, unknown>[] = [];
    await processAnalyzePullRequestJob(
      {
        job_id: "job-check-existing",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 63,
        head_sha: "existing123",
        queued_at: "2025-01-01T00:00:00Z",
        check_run_id: 99,
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        createPullRequestReviewFn: async () => ({
          id: 1, html_url: "https://github.com/x", body: null, state: "commented",
        }),
        createCheckRunFn: async () => {
          createCheckRunCalled = true;
          return { id: 1, html_url: "https://github.com/x", status: "in_progress" as const, conclusion: null };
        },
        updateCheckRunFn: async (options) => {
          capturedUpdates.push({
            checkRunId: options.checkRunId,
            status: options.status,
            conclusion: options.conclusion,
          });
          return { id: 99, html_url: "https://github.com/x", status: options.status, conclusion: options.conclusion ?? null };
        },
      },
    );

    expect(createCheckRunCalled).toBe(false);
    expect(
      capturedUpdates.some(
        (update) => update.checkRunId === 99 && update.status === "in_progress",
      ),
    ).toBe(true);
    expect(
      capturedUpdates.some(
        (update) =>
          update.checkRunId === 99 &&
          update.status === "completed" &&
          update.conclusion === "success",
      ),
    ).toBe(true);
  });

  test("skips check run creation when deliveryMode is not github", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let checkRunCalled = false;
    await processAnalyzePullRequestJob(
      {
        job_id: "job-no-check",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 61,
        head_sha: "nocheck456",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        createCheckRunFn: async () => {
          checkRunCalled = true;
          return { id: 1, html_url: "https://github.com/x", status: "completed", conclusion: "success" };
        },
      },
    );

    expect(checkRunCalled).toBe(false);
  });

  test("continues gracefully when check run creation fails", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const errors: string[] = [];
    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-check-fail",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 62,
        head_sha: "failcheck789",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        createPullRequestReviewFn: async () => ({
          id: 1, html_url: "https://github.com/x", body: null, state: "commented",
        }),
        createCheckRunFn: async () => {
          throw new Error("Checks API permission denied");
        },
        logError: (msg) => errors.push(msg),
      },
    );

    expect(summary.jobId).toBe("job-check-fail");
    expect(errors.some((msg) => msg.includes("in-progress check run"))).toBe(true);
    expect(errors.some((msg) => msg.includes("check_run_failed"))).toBe(true);
  });

  test("posts summary as review body via batch review API", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const capturedReviewOptions: CreatePullRequestReviewOptions[] = [];
    await processAnalyzePullRequestJob(
      {
        job_id: "job-summary",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 70,
        head_sha: "sum123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,1 +1,1 @@\n-old\n+new",
          },
          {
            filename: "src/b.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,1 +1,1 @@\n-old\n+new",
          },
        ],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        createPullRequestReviewFn: async (options) => {
          capturedReviewOptions.push(options);
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
        createCheckRunFn: async () => ({
          id: 1,
          html_url: "https://github.com/x",
          status: "in_progress" as const,
          conclusion: null,
        }),
        updateCheckRunFn: async () => ({
          id: 1,
          html_url: "https://github.com/x",
          status: "completed" as const,
          conclusion: "success" as const,
        }),
      },
    );

    expect(capturedReviewOptions[0]).toBeDefined();
    expect(capturedReviewOptions[0]!.body).toBe("2 files reviewed, 0 comments");
    expect(capturedReviewOptions[0]!.event).toBe("COMMENT");
    expect(capturedReviewOptions[0]!.comments).toEqual([]);
  });

  test("skips processing when PR is closed", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let executeRulesCalled = false;
    const logs: string[] = [];
    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-closed-pr",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 80,
        head_sha: "closed123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => ({
          number: 80,
          state: "closed",
          merged: false,
          title: "Closed PR",
        }),
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => {
          executeRulesCalled = true;
          return {
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
            },
            failedRuleIds: [],
          };
        },
        logInfo: (msg) => logs.push(msg),
      },
    );

    expect(executeRulesCalled).toBe(false);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(0);
    expect(summary.postedCommentCount).toBe(0);
    expect(logs.some((msg) => msg.includes("skipped_closed_pr"))).toBe(true);
  });

  test("completes queued check run when PR is closed and check_run_id exists", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let capturedUpdate: Record<string, unknown> | null = null;
    await processAnalyzePullRequestJob(
      {
        job_id: "job-closed-check",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 83,
        head_sha: "closed-check-123",
        queued_at: "2025-01-01T00:00:00Z",
        check_run_id: 200,
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => ({
          number: 83,
          state: "closed" as const,
          merged: false,
          title: "Closed PR",
        }),
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 0,
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        updateCheckRunFn: async (options) => {
          capturedUpdate = {
            checkRunId: options.checkRunId,
            status: options.status,
            conclusion: options.conclusion,
          };
          return { id: 200, html_url: "https://github.com/x", status: "completed", conclusion: "neutral" };
        },
      },
    );

    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate!.checkRunId).toBe(200);
    expect(capturedUpdate!.status).toBe("completed");
    expect(capturedUpdate!.conclusion).toBe("neutral");
  });

  test("skips processing when PR is merged", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let executeRulesCalled = false;
    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-merged-pr",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 81,
        head_sha: "merged456",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => ({
          number: 81,
          state: "closed",
          merged: true,
          title: "Merged PR",
        }),
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => {
          executeRulesCalled = true;
          return {
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
            },
            failedRuleIds: [],
          };
        },
      },
    );

    expect(executeRulesCalled).toBe(false);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(0);
  });

  test("continues processing when PR is open", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let executeRulesCalled = false;
    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-open-pr",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 82,
        head_sha: "open789",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => ({
          number: 82,
          state: "open",
          merged: false,
          title: "Open PR",
        }),
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => {
          executeRulesCalled = true;
          return {
            findings: [],
            summary: {
              totalRules: 1,
              successfulRules: 1,
              failedRules: 0,
              totalFindings: 0,
              findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
            },
            failedRuleIds: [],
          };
        },
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );

    expect(executeRulesCalled).toBe(true);
    expect(summary.totalRules).toBe(1);
    expect(summary.successfulRules).toBe(1);
  });

  test("resolves outdated threads before posting new ones in github delivery mode", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const resolvedThreadIds: string[] = [];
    const finding = createFinding("finding-new", 0.95, "clean");

    await processAnalyzePullRequestJob(
      {
        job_id: "job-resolve",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 90,
        head_sha: "min123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        githubFetchOptions: workerFetchOptions,
        rules: [],
        fetchPullRequestFn: async () => openPullRequestState,
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "inst-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,1 +1,2 @@\n-const a = 1;\n+const b = 2;",
          },
        ],
        executeRulesFn: async () => ({
          findings: [finding],
          summary: {
            totalRules: 1,
            successfulRules: 1,
            failedRules: 0,
            totalFindings: 1,
            findingsByCategory: { clean: 1, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        listPullRequestSummaryCommentsFn: async () => [
          {
            id: 800,
            node_id: "IC_kwDOold800",
            html_url: "https://github.com/acme/widget/pull/90#issuecomment-800",
            body: "<!-- mergewise-meta dedupeKey=acme/widget#90:old-finding findingId=old ruleId=rule-a category=clean confidence=0.90 -->",
          },
        ],
        listPullRequestReviewThreadsFn: async () => [
          {
            id: "thread-old",
            isResolved: false,
            isOutdated: false,
            firstCommentBody: "<!-- mergewise-meta dedupeKey=acme/widget#90:old-finding findingId=old ruleId=rule-a category=clean confidence=0.90 -->",
          },
        ],
        resolveReviewThreadFn: async (opts) => {
          resolvedThreadIds.push(opts.threadId);
          return { isResolved: true };
        },
        createPullRequestReviewFn: async () => ({
          id: 1, html_url: "https://github.com/x", body: null, state: "commented",
        }),
        createCheckRunFn: async () => ({
          id: 1, html_url: "https://github.com/x", status: "in_progress", conclusion: null,
        }),
        updateCheckRunFn: async () => ({
          id: 1, html_url: "https://github.com/x", status: "completed", conclusion: "success",
        }),
        logInfo: () => {},
        logError: () => {},
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );

    expect(resolvedThreadIds).toContain("thread-old");
  });

  test("transitions queued check run to failure when fetchPullRequest throws", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    let capturedCheckRunUpdate: Record<string, unknown> | null = null;
    let thrownError: unknown;

    try {
      await processAnalyzePullRequestJob(
        {
          job_id: "job-fetch-fail",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 95,
          head_sha: "fail123",
          queued_at: "2025-01-01T00:00:00Z",
          check_run_id: 777,
        },
        {
          deliveryMode: "github",
          githubFetchOptions: workerFetchOptions,
          rules: [],
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "inst-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => [],
          fetchPullRequestFn: async () => {
            throw new GitHubApiError(500, "GET", "https://api.github.com/x", "server error");
          },
          updateCheckRunFn: async (options) => {
            capturedCheckRunUpdate = {
              checkRunId: options.checkRunId,
              status: options.status,
              conclusion: options.conclusion,
            };
            return { id: 777, html_url: "https://github.com/x", status: "completed", conclusion: "failure" };
          },
          createCheckRunFn: async () => ({
            id: 1, html_url: "https://github.com/x", status: "in_progress", conclusion: null,
          }),
          logInfo: () => {},
          logError: () => {},
        },
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect(capturedCheckRunUpdate).not.toBeNull();
    expect(capturedCheckRunUpdate!.checkRunId).toBe(777);
    expect(capturedCheckRunUpdate!.status).toBe("completed");
    expect(capturedCheckRunUpdate!.conclusion).toBe("failure");
  });
});

describe("processAnalyzePullRequestJob feedback logging", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("emits feedback_summary when existing comments have reactions", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const logs: string[] = [];

    await processAnalyzePullRequestJob(
      {
        job_id: "job-feedback",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 50,
        head_sha: "abc123",
        trace_id: "trace-feedback",
        queued_at: "2026-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        rules: [createRule("rule-a")],
        githubFetchOptions: workerFetchOptions,
        logInfo: (msg: string) => logs.push(msg),
        logError: () => {},
        createGitHubAppJwtFn: () => "fake-jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "ghs_token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        fetchPullRequestFn: async () => openPullRequestState,
        createPullRequestReviewFn: async () => ({
          id: 1,
          html_url: "",
          body: null,
          state: "COMMENTED",
        }),
        createCheckRunFn: async () => ({
          id: 1,
          html_url: "",
          status: "completed",
          conclusion: "success",
        }),
        listPullRequestSummaryCommentsFn: async () => [
          {
            id: 100,
            node_id: "IC_100",
            html_url: "",
            body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=rule-a category=safety confidence=0.90 -->",
            reactions: { ...ZERO_REACTIONS, "+1": 2, "-1": 1 },
          },
        ],
        listPullRequestReviewThreadsFn: async () => [],
        postPullRequestSummaryCommentFn: async (opts) => ({
          id: 200,
          node_id: "IC_200",
          html_url: "",
          body: opts.body,
        }),
        now: () => new Date("2026-01-02T03:04:05Z"),
      },
    );

    const feedbackLine = logs.find(
      (line) => line.includes("comment_feedback") && line.includes("findingId=f1"),
    );
    expect(feedbackLine).toBeDefined();
    expect(feedbackLine).toContain("ruleId=rule-a");
    expect(feedbackLine).toContain("thumbsUp=");
    expect(feedbackLine).toContain("thumbsDown=");

    const summaryLine = logs.find((line) => line.includes("feedback_summary"));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain("totalComments=");
    expect(summaryLine).toContain("withReactions=");
  });

  test("suppresses feedback_summary log when no mergewise comments exist", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const logs: string[] = [];

    await processAnalyzePullRequestJob(
      {
        job_id: "job-no-feedback",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 50,
        head_sha: "abc123",
        queued_at: "2026-01-01T00:00:00Z",
      },
      {
        deliveryMode: "github",
        rules: [],
        githubFetchOptions: workerFetchOptions,
        logInfo: (msg: string) => logs.push(msg),
        logError: () => {},
        createGitHubAppJwtFn: () => "fake-jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "ghs_token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        fetchPullRequestFn: async () => openPullRequestState,
        createPullRequestReviewFn: async () => ({
          id: 1,
          html_url: "",
          body: null,
          state: "COMMENTED",
        }),
        createCheckRunFn: async () => ({
          id: 1,
          html_url: "",
          status: "completed",
          conclusion: "success",
        }),
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        postPullRequestSummaryCommentFn: async (opts) => ({
          id: 200,
          node_id: "IC_200",
          html_url: "",
          body: opts.body,
        }),
        now: () => new Date("2026-01-02T03:04:05Z"),
      },
    );

    const summaryLine = logs.find((line) => line.includes("feedback_summary"));
    expect(summaryLine).toBeUndefined();
  });
});
