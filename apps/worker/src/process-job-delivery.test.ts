import { afterEach, describe, expect, test } from "bun:test";

import { toPRNumber } from "@mergewise/shared-types";

import { processAnalyzePullRequestJob } from "./index";
import {
  createAnalyzeJob,
  openPullRequestState,
  workerFetchOptions,
} from "./test-helpers";

describe("processAnalyzePullRequestJob delivery", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("updates existing check run instead of creating when check_run_id is present on job", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let createCheckRunCalled = false;
    const capturedUpdates: Record<string, unknown>[] = [];
    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(63), check_run_id: 99 }),
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
        (update) => update["checkRunId"] === 99 && update["status"] === "in_progress",
      ),
    ).toBe(true);
    expect(
      capturedUpdates.some(
        (update) =>
          update["checkRunId"] === 99 &&
          update["status"] === "completed" &&
          update["conclusion"] === "success",
      ),
    ).toBe(true);
  });

  test("skips check run creation when deliveryMode is not github", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let checkRunCalled = false;
    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(61) }),
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
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const errors: string[] = [];
    const checkFailJob = createAnalyzeJob({ pr_number: toPRNumber(62) });
    const summary = await processAnalyzePullRequestJob(
      checkFailJob,
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
        logError: (message) => errors.push(message),
      },
    );

    expect(summary.jobId).toBe(checkFailJob.job_id);
    expect(errors.some((message) => message.includes("in-progress check run"))).toBe(true);
    expect(errors.some((message) => message.includes("check_run_failed"))).toBe(true);
  });

  test("skips review submission when there are zero inline comments", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let reviewCalled = false;
    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(70) }),
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
          reviewCalled = true;
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

    expect(reviewCalled).toBe(false);
  });

  test("skips processing when PR is closed", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let executeRulesCalled = false;
    const logs: string[] = [];
    const summary = await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(80) }),
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
        logInfo: (message) => logs.push(message),
      },
    );

    expect(executeRulesCalled).toBe(false);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(0);
    expect(summary.postedCommentCount).toBe(0);
    expect(logs.some((message) => message.includes("skipped_closed_pr"))).toBe(true);
  });

  test("completes queued check run when PR is closed and check_run_id exists", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let capturedUpdate: Record<string, unknown> | null = null;
    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(83), check_run_id: 200 }),
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
    expect(capturedUpdate!["checkRunId"]).toBe(200);
    expect(capturedUpdate!["status"]).toBe("completed");
    expect(capturedUpdate!["conclusion"]).toBe("neutral");
  });

  test("skips processing when PR is merged", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let executeRulesCalled = false;
    const summary = await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(81) }),
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
});
