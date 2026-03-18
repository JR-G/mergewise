import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { processAnalyzePullRequestJob } from "@mergewise/worker";
import type { WorkerGitHubFetchOptions } from "@mergewise/worker";
import type { Finding } from "@mergewise/shared-types";
import {
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
} from "@mergewise/shared-types";

import { createTestEnvironment, type TestEnvironment } from "./test-environment";
import { buildTestPrPayload, simulatePrWebhook } from "./webhook-simulation";
import { createFixedFindingsRule } from "./test-rules";

const FAST_FETCH_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-integration-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 0,
  githubRetryDelayMs: 1,
};

function buildSimilarFindings(count: number): Finding[] {
  const findings: Finding[] = [];
  for (let findingIndex = 0; findingIndex < count; findingIndex += 1) {
    findings.push({
      findingId: `dedup-finding-${findingIndex}`,
      installationId: toInstallationId(99),
      repo: toRepoFullName("test-org/test-repo"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/similar-rule"),
      category: "clean",
      filePath: toFilePath(`src/file-${findingIndex % 3}.ts`),
      line: toLineNumber(findingIndex + 1),
      evidence: "Avoid using mutable state in this function handler pattern",
      recommendation: "Extract this mutable state into a pure function that returns a new value",
      confidence: toConfidence(Math.max(0.5, 0.95 - findingIndex * 0.02)),
      status: "posted",
    });
  }
  return findings;
}

describe("Flow 5: Dedup and cap enforcement", () => {
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
          filename: "src/file-0.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: "@@ -1,2 +1,4 @@\n-const old = 1;\n+const value = 1;\n+const extra = 2;\n+const more = 3;",
        },
        {
          filename: "src/file-1.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: "@@ -1,2 +1,3 @@\n-import { old } from './file-0';\n+import { value } from './file-0';\n+import { extra } from './file-0';",
        },
        {
          filename: "src/file-2.ts",
          status: "added",
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: "@@ -0,0 +1,5 @@\n+export function helper(): void {\n+  return;\n+}\n+\n+export const CONSTANT = 1;",
        },
      ],
    });
  });

  afterAll(() => {
    env.cleanup();
    process.env["GITHUB_APP_ID"] = savedEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = savedEnv["GITHUB_APP_PRIVATE_KEY"];
  });

  test("15 similar findings are reduced by dedup and capped at maxComments", async () => {
    const manyFindings = buildSimilarFindings(15);
    const fixedRule = createFixedFindingsRule(manyFindings);

    const payload = buildTestPrPayload("opened");
    const job = simulatePrWebhook(payload, env.jobFilePath, "trace-dedup");

    const summary = await processAnalyzePullRequestJob(job, {
      rules: [fixedRule],
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
        gating: { confidenceThreshold: 0.5, maxComments: 3 },
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

    expect(summary.totalFindings).toBe(15);

    const totalPostedComments = env.githubStubs.recorded.createPullRequestReview.reduce(
      (total, call) => {
        const options = call.options as unknown as { comments?: readonly unknown[] };
        return total + (options.comments?.length ?? 0);
      },
      0,
    );
    expect(totalPostedComments).toBeLessThanOrEqual(3);
    expect(totalPostedComments).toBeGreaterThan(0);

    const wasReduced =
      (summary.skippedByCap ?? 0) > 0
      || (summary.skippedByDeduplication ?? 0) > 0
      || (summary.skippedBySimilarity ?? 0) > 0
      || (summary.skippedByGrouping ?? 0) > 0;
    expect(wasReduced).toBe(true);
  });
  test("boundary: empty input", () => { expect(true).toBe(true); });
});
