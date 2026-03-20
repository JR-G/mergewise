import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { processAnalyzePullRequestJob } from "@mergewise/worker";
import type { WorkerGitHubFetchOptions } from "@mergewise/worker";

import { createTestEnvironment, type TestEnvironment } from "./test-environment";
import { buildTestPrPayload, simulatePrWebhook, readJobsFromFile } from "./webhook-simulation";
import { createEchoRule } from "./test-rules";

const FAST_FETCH_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-integration-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 0,
  githubRetryDelayMs: 1,
};

describe("Flow 1: PR webhook → job queue → worker → GitHub comment", () => {
  let env: TestEnvironment;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv["GITHUB_APP_ID"] = process.env["GITHUB_APP_ID"];
    savedEnv["GITHUB_APP_PRIVATE_KEY"] = process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_ID"] = "12345";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "test-private-key-pem";

    env = createTestEnvironment({
      prFiles: [
        {
          filename: "src/utils.ts",
          status: "modified",
          additions: 5,
          deletions: 2,
          changes: 7,
          patch: "@@ -1,3 +1,6 @@\n-const old = 1;\n+const value = 1;\n+const extra = 2;\n+const more = 3;",
        },
        {
          filename: "src/index.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ -1,2 +1,3 @@\n-import { old } from './utils';\n+import { value } from './utils';\n+import { extra } from './utils';",
        },
      ],
    });
  });

  afterAll(() => {
    env.cleanup();
    process.env["GITHUB_APP_ID"] = savedEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = savedEnv["GITHUB_APP_PRIVATE_KEY"];
  });

  test("webhook payload is serialised to NDJSON and deserialised back", () => {
    const payload = buildTestPrPayload("opened");
    const job = simulatePrWebhook(payload, env.jobFilePath, "trace-flow1");
    const jobs = readJobsFromFile(env.jobFilePath);

    expect(jobs.some((queued) => queued.job_id === job.job_id)).toBe(true);

    const roundtripped = jobs.find((queued) => queued.job_id === job.job_id);
    expect(roundtripped).toBeDefined();
    expect(roundtripped!.repo_full_name).toBe("test-org/test-repo");
  });

  test("worker processes job through real rule engine and delivers to GitHub stubs", async () => {
    const payload = buildTestPrPayload("opened");
    const job = simulatePrWebhook(payload, env.jobFilePath, "trace-review");
    const echoRule = createEchoRule("test/echo");

    const summary = await processAnalyzePullRequestJob(job, {
      rules: [echoRule],
      githubFetchOptions: FAST_FETCH_OPTIONS,
      deliveryMode: "github",
      ...env.githubStubs.deps,
      feedbackStore: env.feedbackStore,
      debtStore: env.debtStore,
      logInfo: env.logInfo,
      logError: env.logError,
      logWarn: env.logWarn,
      now: () => new Date("2026-01-15T00:00:00Z"),
    });

    expect(summary.totalFindings).toBeGreaterThan(0);
    expect(env.githubStubs.recorded.createCheckRun.length).toBeGreaterThan(0);
    expect(env.githubStubs.recorded.updateCheckRun.length).toBeGreaterThan(0);

    const hasReviewOrSummary =
      env.githubStubs.recorded.createPullRequestReview.length > 0
      || env.githubStubs.recorded.postPullRequestSummaryComment.length > 0;
    expect(hasReviewOrSummary).toBe(true);
  });

  test("PR with no rules produces no findings", async () => {
    const payload = buildTestPrPayload("opened");
    const job = simulatePrWebhook(payload, env.jobFilePath, "trace-no-rules");

    const summary = await processAnalyzePullRequestJob(job, {
      rules: [],
      githubFetchOptions: FAST_FETCH_OPTIONS,
      deliveryMode: "github",
      ...env.githubStubs.deps,
      feedbackStore: env.feedbackStore,
      debtStore: env.debtStore,
      logInfo: env.logInfo,
      logError: env.logError,
      logWarn: env.logWarn,
      now: () => new Date("2026-01-15T00:00:00Z"),
    });

    expect(summary.totalFindings).toBe(0);
  });
});
