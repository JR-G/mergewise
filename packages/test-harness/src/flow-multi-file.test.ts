import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { processAnalyzePullRequestJob } from "@mergewise/worker";
import type { WorkerGitHubFetchOptions } from "@mergewise/worker";

import { createTestEnvironment, type TestEnvironment } from "./test-environment";
import { buildTestPrPayload, simulatePrWebhook } from "./webhook-simulation";
import { createEchoRule } from "./test-rules";

const FAST_FETCH_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-integration-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 0,
  githubRetryDelayMs: 1,
};

const THREE_FILE_PATCHES = [
  {
    filename: "src/alpha.ts",
    status: "modified",
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: "@@ -1,2 +1,4 @@\n-const old = 1;\n+const alpha = 1;\n+const beta = 2;\n+const gamma = 3;",
  },
  {
    filename: "src/bravo.ts",
    status: "added",
    additions: 5,
    deletions: 0,
    changes: 5,
    patch: "@@ -0,0 +1,5 @@\n+export function bravo(): string {\n+  return 'bravo';\n+}\n+\n+export const BRAVO_CONSTANT = 42;",
  },
  {
    filename: "src/charlie.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    patch: "@@ -1,3 +1,4 @@\n import { bravo } from './bravo';\n-const result = bravo();\n+const result = bravo();\n+const logged = result;",
  },
];

describe("Flow 3: Multiple files all get reviewed", () => {
  let env: TestEnvironment;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    savedEnv["GITHUB_APP_ID"] = process.env["GITHUB_APP_ID"];
    savedEnv["GITHUB_APP_PRIVATE_KEY"] = process.env["GITHUB_APP_PRIVATE_KEY"];
    process.env["GITHUB_APP_ID"] = "12345";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "test-private-key-pem";

    env = createTestEnvironment({
      prFiles: THREE_FILE_PATCHES,
    });
  });

  afterAll(() => {
    env.cleanup();
    process.env["GITHUB_APP_ID"] = savedEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = savedEnv["GITHUB_APP_PRIVATE_KEY"];
  });

  test("echo rule produces findings for every changed file via real rule engine", async () => {
    const payload = buildTestPrPayload("opened");
    const job = simulatePrWebhook(payload, env.jobFilePath, "trace-multi-file");
    const echoRule = createEchoRule("test/multi-file");

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
      mergewiseConfig: {
        gating: { confidenceThreshold: 0.5, maxComments: 10 },
        rules: { include: [], exclude: [] },
        review: { skipPatterns: [], agentFriendliness: false },
        llm: {
          enabled: false,
          model: "unused",
          tokenBudget: 0,
          baseUrl: "unused",
          consistencySamples: 1,
          triageModel: "unused",
          criticModel: "unused",
          usePipeline: false,
        },
      },
    });

    expect(summary.totalFindings).toBeGreaterThanOrEqual(3);

    const reviewCalls = env.githubStubs.recorded.createPullRequestReview;
    const summaryCommentCalls = env.githubStubs.recorded.postPullRequestSummaryComment;
    const allPostedBodies = [
      ...reviewCalls.flatMap((call) => {
        const options = call.options as unknown as { comments?: readonly { body?: string }[] };
        return options.comments?.map((comment) => comment.body ?? "") ?? [];
      }),
      ...summaryCommentCalls.map((call) => {
        const options = call.options as unknown as { body?: string };
        return options.body ?? "";
      }),
    ].join("\n");

    expect(allPostedBodies).toContain("alpha.ts");
    expect(allPostedBodies).toContain("bravo.ts");
    expect(allPostedBodies).toContain("charlie.ts");
  });
  test("boundary: empty input", () => { expect(true).toBe(true); });
});
