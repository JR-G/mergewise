import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubApiError } from "@mergewise/github-client";

import { toPRNumber } from "@mergewise/shared-types";

import { processAnalyzePullRequestJob } from "./index";
import {
  createAnalyzeJob,
  createFinding,
  createRule,
  openPullRequestState,
  TEST_SHA,
  workerFetchOptions,
} from "./test-helpers";

describe("processAnalyzePullRequestJob", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("successful fetch feeds rule execution and returns deterministic summary", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const capturedContexts: unknown[] = [];
    const job = createAnalyzeJob();

    const summary = await processAnalyzePullRequestJob(
      job,
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
    expect(summary.jobId).toBe(job.job_id);
    expect(summary.idempotencyKey).toBe(`acme/widget#50@${TEST_SHA}`);
    expect(summary.traceId).toBe(job.job_id);
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(summary.checkOutput?.title).toContain("Review completed");
  });

  test("non-retryable GitHub fetch failure is surfaced", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        createAnalyzeJob({ pr_number: toPRNumber(51) }),
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
    process.env["GITHUB_APP_ID"] = "123";
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_PRIVATE_KEY_PEM"] = "legacy-private-key";

    const legacyJob = createAnalyzeJob({ pr_number: toPRNumber(52) });
    const summary = await processAnalyzePullRequestJob(
      legacyJob,
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

    expect(summary.jobId).toBe(legacyJob.job_id);
    expect(summary.traceId).toBe(legacyJob.job_id);
  });

  test("supports GITHUB_APP_PRIVATE_KEY_PATH when inline key vars are unset", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PEM"];

    const temporaryDirectoryPath = mkdtempSync(join(tmpdir(), "mergewise-worker-test-"));
    const privateKeyPath = join(temporaryDirectoryPath, "private-key.pem");
    writeFileSync(privateKeyPath, "path-private-key\n");
    process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = privateKeyPath;

    try {
      const pathJob = createAnalyzeJob({ pr_number: toPRNumber(52) });
      const summary = await processAnalyzePullRequestJob(
        pathJob,
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

      expect(summary.jobId).toBe(pathJob.job_id);
    } finally {
      rmSync(temporaryDirectoryPath, { recursive: true, force: true });
      delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    }
  });

  test("invalid GITHUB_APP_PRIVATE_KEY_PATH surfaces explicit error", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PEM"];
    process.env["GITHUB_APP_PRIVATE_KEY_PATH"] = "/tmp/mergewise-missing-private-key.pem";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        createAnalyzeJob({ pr_number: toPRNumber(53) }),
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

    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
  });

  test("invalid GITHUB_APP_ID surfaces explicit error", async () => {
    process.env["GITHUB_APP_ID"] = "not-a-number";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let thrownError: unknown;
    try {
      await processAnalyzePullRequestJob(
        createAnalyzeJob({ pr_number: toPRNumber(53) }),
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
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const capturedRuleIds: string[][] = [];
    const rules = [createRule("test/rule-a"), createRule("test/rule-b"), createRule("test/rule-c")];

    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(54) }),
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
            include: ["test/rule-a", "test/rule-c"],
            exclude: ["test/rule-c"],
          },
          review: { skipPatterns: [], agentFriendliness: false },
          llm: {
            enabled: false,
            model: "gpt-4o",
            triageModel: "gpt-4.1-mini",
            criticModel: "gpt-4.1-mini",
            usePipeline: true,
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

    expect(capturedRuleIds.flat()).toContain("test/rule-a");
    expect(capturedRuleIds.flat()).not.toContain("test/rule-b");
    expect(capturedRuleIds.flat()).not.toContain("test/rule-c");
  });

  test("applies confidence gating to execution summary and delivery cap separately", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const gatingJob = createAnalyzeJob({ pr_number: toPRNumber(55) });
    const summary = await processAnalyzePullRequestJob(
      gatingJob,
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
          review: { skipPatterns: [], agentFriendliness: false },
          llm: {
            enabled: false,
            model: "gpt-4o",
            triageModel: "gpt-4.1-mini",
            criticModel: "gpt-4.1-mini",
            usePipeline: true,
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
    expect(summary.traceId).toBe(gatingJob.job_id);
    expect(summary.checkOutput?.title).toBe("Review completed");
  });

  test("creates in-progress check run then updates to completed when deliveryMode is github", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let capturedInProgressCreate: Record<string, unknown> | null = null;
    let capturedCompletedUpdate: Record<string, unknown> | null = null;
    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(60) }),
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
    expect(capturedInProgressCreate!["owner"]).toBe("acme");
    expect(capturedInProgressCreate!["name"]).toBe("Mergewise");
    expect(capturedInProgressCreate!["status"]).toBe("in_progress");
    expect(capturedCompletedUpdate).not.toBeNull();
    expect(capturedCompletedUpdate!["checkRunId"]).toBe(42);
    expect(capturedCompletedUpdate!["status"]).toBe("completed");
    expect(capturedCompletedUpdate!["conclusion"]).toBe("success");
  });
});
