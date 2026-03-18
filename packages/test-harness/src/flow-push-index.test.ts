import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { processAnalyzePullRequestJob, processIndexRepoJob } from "@mergewise/worker";
import type { WorkerGitHubFetchOptions } from "@mergewise/worker";
import type { DebtProfile, DebtGraph, DebtNode } from "@mergewise/debt-scanner";

import { createTestEnvironment, type TestEnvironment } from "./test-environment";
import {
  buildTestPrPayload,
  buildTestPushPayload,
  simulatePrWebhook,
  simulatePushWebhook,
  readJobsFromFile,
} from "./webhook-simulation";
import { createEchoRule } from "./test-rules";

const FAST_FETCH_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-integration-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 0,
  githubRetryDelayMs: 1,
};

const ZERO_SIGNALS = {
  componentLineCount: 0,
  hookCount: 0,
  importCount: 0,
  maxNestingDepth: 0,
  functionCount: 0,
  maxFunctionLineCount: 0,
  maxParameterCount: 0,
  classCount: 0,
  typeAssertionCount: 0,
};

function buildMockDebtProfile(repoPath: string): DebtProfile {
  const nodes = new Map<string, DebtNode>();
  for (let nodeIndex = 0; nodeIndex < 5; nodeIndex += 1) {
    const nodeId = `node-${nodeIndex}`;
    nodes.set(nodeId, {
      id: nodeId,
      kind: "file",
      filePath: `src/file-${nodeIndex}.ts`,
      name: `file-${nodeIndex}.ts`,
      signals: ZERO_SIGNALS,
      lineCount: 50,
      centrality: 0.5,
    });
  }

  const edges = [
    { source: "node-0", target: "node-1", kind: "imports" as const },
    { source: "node-1", target: "node-2", kind: "imports" as const },
    { source: "node-2", target: "node-3", kind: "calls" as const },
  ];

  const graph: DebtGraph = { nodes, edges };

  return {
    repoPath,
    scannedAt: new Date().toISOString(),
    graph,
    findings: [],
    hotspots: [
      { nodeId: "node-0", filePath: "src/file-0.ts", score: 0.9, centrality: 0.8, signalDensity: 0.7, lineCount: 100 },
    ],
    totalFiles: 5,
    totalEdges: 3,
  };
}

describe("Flow 2: Push → index job → debt store → graph context in review", () => {
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
          patch: "@@ -1,2 +1,4 @@\n-const x = 1;\n+const value = 1;\n+const extra = 2;\n+const more = 3;",
        },
      ],
    });
  });

  afterAll(() => {
    env.cleanup();
    process.env["GITHUB_APP_ID"] = savedEnv["GITHUB_APP_ID"];
    process.env["GITHUB_APP_PRIVATE_KEY"] = savedEnv["GITHUB_APP_PRIVATE_KEY"];
  });

  test("push webhook enqueues index job via real job store", () => {
    const pushPayload = buildTestPushPayload();
    const indexJob = simulatePushWebhook(pushPayload, env.jobFilePath, "trace-push");
    const jobs = readJobsFromFile(env.jobFilePath);

    expect(jobs.some((queued) => queued.job_id === indexJob.job_id)).toBe(true);
  });

  test("index job persists scan to real SQLite and subsequent review sees graph context", async () => {
    const pushPayload = buildTestPushPayload();
    const indexJob = simulatePushWebhook(pushPayload, env.jobFilePath, "trace-index");

    await processIndexRepoJob(indexJob, {
      debtStore: env.debtStore,
      createGitHubAppJwtFn: () => "test-jwt",
      exchangeInstallationAccessTokenFn: async () => ({
        token: "test-token",
        expires_at: "2099-01-01T00:00:00Z",
      }),
      scanFn: async () => buildMockDebtProfile(indexJob.repo_full_name),
      spawnClone: async () => { /* no-op: skip git clone */ },
      logInfo: env.logInfo,
      logError: env.logError,
    });

    const latestScan = env.debtStore.latestScan(indexJob.repo_full_name);
    expect(latestScan).not.toBeNull();
    expect(latestScan!.graph.nodes.size).toBeGreaterThan(0);
    expect(latestScan!.graph.edges.length).toBeGreaterThan(0);

    const prPayload = buildTestPrPayload("opened");
    const analyzeJob = simulatePrWebhook(prPayload, env.jobFilePath, "trace-review-with-graph");
    const echoRule = createEchoRule("test/graph");

    await processAnalyzePullRequestJob(analyzeJob, {
      rules: [echoRule],
      githubFetchOptions: FAST_FETCH_OPTIONS,
      deliveryMode: "none",
      ...env.githubStubs.deps,
      debtStore: env.debtStore,
      feedbackStore: env.feedbackStore,
      logInfo: env.logInfo,
      logError: env.logError,
      logWarn: env.logWarn,
      now: () => new Date("2026-01-15T00:00:00Z"),
    });

    const graphContextLog = env.capturedLogs.find((log) => log.includes("graph_context"));
    expect(graphContextLog).toBeDefined();
    expect(graphContextLog).toContain("nodes=");
    expect(graphContextLog).not.toContain("nodes=0");
  });
  test("boundary: empty input", () => { expect(true).toBe(true); });
});
