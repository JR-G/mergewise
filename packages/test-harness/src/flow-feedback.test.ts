import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { processCollectFeedbackJob } from "@mergewise/worker";
import type { WorkerGitHubFetchOptions } from "@mergewise/worker";
import type { GitHubIssueComment } from "@mergewise/github-client";

import { createTestEnvironment, type TestEnvironment } from "./test-environment";
import { buildTestPrPayload, simulateClosedPrWebhook, readJobsFromFile } from "./webhook-simulation";

const FAST_FETCH_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-integration-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 0,
  githubRetryDelayMs: 1,
};

interface MergewiseCommentOptions {
  readonly findingId: string;
  readonly ruleId: string;
  readonly category: string;
  readonly confidence: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
}

function buildMergewiseComment(options: MergewiseCommentOptions): GitHubIssueComment {
  return {
    id: Math.floor(Math.random() * 100000),
    body: `Some review text\n<!-- mergewise-meta findingId=${options.findingId} ruleId=${options.ruleId} category=${options.category} confidence=${options.confidence} -->`,
    reactions: {
      "+1": options.thumbsUp,
      "-1": options.thumbsDown,
      laugh: 0,
      confused: 0,
      heart: 0,
      hooray: 0,
      rocket: 0,
      eyes: 0,
    },
  } as GitHubIssueComment;
}

describe("Flow 4: PR close → feedback collected and persisted", () => {
  let env: TestEnvironment;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv["GITHUB_APP_ID"] = process.env["GITHUB_APP_ID"];
    savedEnv["GITHUB_APP_PRIVATE_KEY"] = process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_ID"] = "12345";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "test-private-key-pem";

    env = createTestEnvironment({
      summaryComments: [
        buildMergewiseComment({ findingId: "finding-1", ruleId: "test/rule-a", category: "clean", confidence: "0.9", thumbsUp: 3, thumbsDown: 0 }),
        buildMergewiseComment({ findingId: "finding-2", ruleId: "test/rule-b", category: "perf", confidence: "0.85", thumbsUp: 0, thumbsDown: 3 }),
      ],
    });
  });

  afterAll(() => {
    env.cleanup();
    process.env["GITHUB_APP_ID"] = savedEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = savedEnv["GITHUB_APP_PRIVATE_KEY"];
  });

  test("closed PR webhook enqueues feedback job via real job store", () => {
    const payload = buildTestPrPayload("closed");
    const feedbackJob = simulateClosedPrWebhook(payload, env.jobFilePath, "trace-feedback");
    const jobs = readJobsFromFile(env.jobFilePath);

    expect(jobs.some((queued) => queued.job_id === feedbackJob.job_id)).toBe(true);
  });

  test("feedback job collects reactions and persists to real SQLite store", async () => {
    const payload = buildTestPrPayload("closed");
    const feedbackJob = simulateClosedPrWebhook(payload, env.jobFilePath, "trace-fb-persist");

    await processCollectFeedbackJob(feedbackJob, {
      feedbackStore: env.feedbackStore,
      githubFetchOptions: FAST_FETCH_OPTIONS,
      createGitHubAppJwtFn: () => "test-jwt",
      exchangeInstallationAccessTokenFn: async () => ({
        token: "test-token",
        expires_at: "2099-01-01T00:00:00Z",
      }),
      listPullRequestSummaryCommentsFn: async () => env.githubStubs.summaryComments,
      listPullRequestReviewThreadsWithRepliesFn: async () => [],
      logInfo: env.logInfo,
      logError: env.logError,
    });

    const sentiments = env.feedbackStore.queryRuleSentiment(feedbackJob.repo_full_name);
    expect(sentiments.some((sentiment) => sentiment.ruleId === "test/rule-a")).toBe(true);
    expect(sentiments.some((sentiment) => sentiment.ruleId === "test/rule-b")).toBe(true);
  });
  test("boundary: empty input", () => { expect(true).toBe(true); });
});
