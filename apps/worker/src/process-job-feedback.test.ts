import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiError } from "@mergewise/github-client";

import { toPRNumber } from "@mergewise/shared-types";

import { processAnalyzePullRequestJob } from "./index";
import {
  createAnalyzeJob,
  createFinding,
  createRule,
  openPullRequestState,
  workerFetchOptions,
  ZERO_REACTIONS,
} from "./test-helpers";

describe("processAnalyzePullRequestJob state and threads", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("continues processing when PR is open", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let executeRulesCalled = false;
    const summary = await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(82) }),
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
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const resolvedThreadIds: string[] = [];
    const finding = createFinding("finding-new", 0.95, "clean");

    await processAnalyzePullRequestJob(
      createAnalyzeJob({ pr_number: toPRNumber(90) }),
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
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    let capturedCheckRunUpdate: Record<string, unknown> | null = null;
    let thrownError: unknown;

    try {
      await processAnalyzePullRequestJob(
        createAnalyzeJob({ pr_number: toPRNumber(95), check_run_id: 777 }),
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
    expect(capturedCheckRunUpdate!["checkRunId"]).toBe(777);
    expect(capturedCheckRunUpdate!["status"]).toBe("completed");
    expect(capturedCheckRunUpdate!["conclusion"]).toBe("failure");
  });
});

describe("processAnalyzePullRequestJob feedback logging", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("emits feedback_summary when existing comments have reactions", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const logs: string[] = [];

    await processAnalyzePullRequestJob(
      createAnalyzeJob({ trace_id: "trace-feedback", queued_at: "2026-01-01T00:00:00Z" }),
      {
        deliveryMode: "github",
        rules: [createRule("test/rule-a")],
        githubFetchOptions: workerFetchOptions,
        logInfo: (message: string) => logs.push(message),
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
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const logs: string[] = [];

    await processAnalyzePullRequestJob(
      createAnalyzeJob({ queued_at: "2026-01-01T00:00:00Z" }),
      {
        deliveryMode: "github",
        rules: [],
        githubFetchOptions: workerFetchOptions,
        logInfo: (message: string) => logs.push(message),
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

describe("processAnalyzePullRequestJob debt store wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("logs graph context when debtStore returns a scan with hotspots", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const logs: string[] = [];

    const debtJob = createAnalyzeJob();

    const summary = await processAnalyzePullRequestJob(
      debtJob,
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
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        logInfo: (message: string) => logs.push(message),
        logError: () => {},
        debtStore: {
          latestScan: () => ({
            repoPath: "acme/widget",
            scannedAt: "2026-01-01T00:00:00Z",
            graph: { nodes: new Map([["src/index.ts", { id: "src/index.ts", kind: "file" as const, filePath: "src/index.ts", signals: { componentLineCount: 0, hookCount: 0, classCount: 0, functionCount: 1, maxFunctionLineCount: 10, maxNestingDepth: 1, maxParameterCount: 1, typeAssertionCount: 0, importCount: 2 }, lineCount: 20, centrality: 0.5 }]]), edges: [] },
            findings: [],
            hotspots: [{ nodeId: "src/index.ts", filePath: "src/index.ts", score: 0.8, centrality: 0.5, signalDensity: 0.3, lineCount: 20 }],
          }),
          saveScan: () => "scan-id",
          listScans: () => [],
          loadScan: () => null,
          close: () => {},
        },
      },
    );

    expect(summary.jobId).toBe(debtJob.job_id);
    const graphLine = logs.find((line) => line.includes("graph_context"));
    expect(graphLine).toBeDefined();
    expect(graphLine).toContain("repo=acme/widget");
    expect(graphLine).toContain("hotspots=1");
    expect(graphLine).toContain("nodes=1");
  });

  test("proceeds without toolkit when debtStore returns no scan", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const logs: string[] = [];
    const errors: string[] = [];
    const noScanJob = createAnalyzeJob();

    const summary = await processAnalyzePullRequestJob(
      noScanJob,
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
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        logInfo: (message: string) => logs.push(message),
        logError: (message: string) => errors.push(message),
        debtStore: {
          latestScan: () => null,
          saveScan: () => "scan-id",
          listScans: () => [],
          loadScan: () => null,
          close: () => {},
        },
      },
    );

    expect(summary.jobId).toBe(noScanJob.job_id);
    const graphLine = logs.find((line) => line.includes("graph_context"));
    expect(graphLine).toBeUndefined();
    expect(errors.some((message) => message.includes("graph_context"))).toBe(false);
  });

  test("logs error and proceeds when debtStore.latestScan throws", async () => {
    process.env["GITHUB_APP_ID"] = "123";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "placeholder-private-key";

    const logs: string[] = [];
    const errors: string[] = [];
    const errorJob = createAnalyzeJob();

    const summary = await processAnalyzePullRequestJob(
      errorJob,
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
            findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          },
          failedRuleIds: [],
        }),
        logInfo: (message: string) => logs.push(message),
        logError: (message: string) => errors.push(message),
        debtStore: {
          latestScan: () => { throw new Error("SQLite disk I/O error"); },
          saveScan: () => "scan-id",
          listScans: () => [],
          loadScan: () => null,
          close: () => {},
        },
      },
    );

    expect(summary.jobId).toBe(errorJob.job_id);
    const graphSuccessLine = logs.find((line) => line.includes("graph_context"));
    expect(graphSuccessLine).toBeUndefined();
    const graphErrorLine = errors.find((line) => line.includes("graph_context_failed"));
    expect(graphErrorLine).toBeDefined();
    expect(graphErrorLine).toContain("SQLite disk I/O error");
    expect(graphErrorLine).toContain("repo=acme/widget");
  });
});
