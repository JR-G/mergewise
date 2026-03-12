import { describe, expect, test } from "bun:test";

import {
  startWorkerProcess,
} from "./main";

const DEFAULT_LLM_MODELS = { triageModel: "gpt-4.1-mini", criticModel: "gpt-4.1-mini", usePipeline: true };

describe("startWorkerProcess job routing", () => {
  test("routes feedback jobs to processCollectFeedbackJobFn and skips analyze handler", async () => {
    const feedbackJobIds: string[] = [];
    const analyzeJobIds: string[] = [];
    const intervalCallbacks: (() => void)[] = [];

    const feedbackJob = {
      type: "collect-feedback" as const,
      job_id: "fb-1",
      installation_id: 9,
      repo_full_name: "acme/widget",
      pr_number: 10,
      queued_at: "2026-02-01T00:00:00.000Z",
    };

    const processHandle = startWorkerProcess({
      loadConfigFn: () => ({
        pollIntervalMs: 3000,
        maxProcessedKeys: 1000,
        githubApiBaseUrl: "https://api.github.com",
        githubUserAgent: "mergewise-worker-test",
        githubRequestTimeoutMs: 1000,
        githubFetchRetries: 2,
        githubRetryDelayMs: 10,
        confidenceThreshold: 0.78,
        maxComments: 20,
        testFileConfidenceThreshold: 0.98,
      }),
      loadMergewiseConfigFn: () => ({
        gating: {
          confidenceThreshold: 0.8,
          maxComments: 10,
        },
        rules: {
          include: [],
          exclude: [],
        },
        review: { skipPatterns: [] },
        llm: {
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => [feedbackJob],
      processAnalyzePullRequestJobFn: async (job) => {
        analyzeJobIds.push(job.job_id);
        return {
          jobId: job.job_id,
          idempotencyKey: `${job.repo_full_name}#${job.pr_number}@${job.head_sha}`,
          repository: job.repo_full_name,
          pullRequestNumber: job.pr_number,
          headSha: job.head_sha,
          totalFindings: 0,
          findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
          totalRules: 0,
          successfulRules: 0,
          failedRules: 0,
          failedRuleIds: [],
          processedAt: "2026-02-01T00:00:00.000Z",
          traceId: job.job_id,
        };
      },
      processCollectFeedbackJobFn: async (job) => {
        feedbackJobIds.push(job.job_id);
      },
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => ({
        start: () => {
          intervalCallbacks.push(() => {
            pollCycle().then(() => undefined, () => undefined);
          });
        },
        stop: async () => {},
        isRunning: () => true,
      }),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await Promise.resolve();

    expect(feedbackJobIds).toEqual(["fb-1"]);
    expect(analyzeJobIds).toEqual([]);

    runPollCycle?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(feedbackJobIds).toEqual(["fb-1"]);

    await processHandle.shutdown();
  });

  test("routes index-repo jobs to processIndexRepoJobFn when debt store is available", async () => {
    const indexJobIds: string[] = [];
    const analyzeJobIds: string[] = [];
    const intervalCallbacks: (() => void)[] = [];

    const indexJob = {
      type: "index-repo" as const,
      job_id: "idx-1",
      installation_id: 42,
      repo_full_name: "acme/widget",
      default_branch: "main",
      head_sha: "sha123",
      queued_at: "2026-02-01T00:00:00.000Z",
    };

    const processHandle = startWorkerProcess({
      loadConfigFn: () => ({
        pollIntervalMs: 3000,
        maxProcessedKeys: 1000,
        githubApiBaseUrl: "https://api.github.com",
        githubUserAgent: "mergewise-worker-test",
        githubRequestTimeoutMs: 1000,
        githubFetchRetries: 2,
        githubRetryDelayMs: 10,
        confidenceThreshold: 0.78,
        maxComments: 20,
        testFileConfidenceThreshold: 0.98,
      }),
      loadMergewiseConfigFn: () => ({
        gating: { confidenceThreshold: 0.8, maxComments: 10 },
        rules: { include: [], exclude: [] },
        review: { skipPatterns: [] },
        llm: {
          enabled: false, model: "gpt-4o", ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000, baseUrl: "https://api.openai.com/v1", consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => [indexJob],
      processAnalyzePullRequestJobFn: async (job) => {
        analyzeJobIds.push(job.job_id);
        return {} as never;
      },
      processIndexRepoJobFn: async (job) => {
        indexJobIds.push(job.job_id);
        return { repoFullName: job.repo_full_name, headSha: job.head_sha, nodeCount: 1, hotspotCount: 0, scanId: "s1" };
      },
      openDebtStoreFn: () => ({
        saveScan: () => "scan-1",
        listScans: () => [],
        loadScan: () => null,
        latestScan: () => null,
        close: () => {},
      }),
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => ({
        start: () => {
          intervalCallbacks.push(() => { pollCycle().then(() => undefined, () => undefined); });
        },
        stop: async () => {},
        isRunning: () => true,
      }),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await Promise.resolve();

    expect(indexJobIds).toEqual(["idx-1"]);
    expect(analyzeJobIds).toEqual([]);

    runPollCycle?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(indexJobIds).toEqual(["idx-1"]);

    await processHandle.shutdown();
  });

  test("skips index-repo jobs without debt store", async () => {
    const infoLogs: string[] = [];
    const intervalCallbacks: (() => void)[] = [];

    const indexJob = {
      type: "index-repo" as const,
      job_id: "idx-2",
      installation_id: 42,
      repo_full_name: "acme/widget",
      default_branch: "main",
      head_sha: "sha456",
      queued_at: "2026-02-01T00:00:00.000Z",
    };

    const processHandle = startWorkerProcess({
      loadConfigFn: () => ({
        pollIntervalMs: 3000,
        maxProcessedKeys: 1000,
        githubApiBaseUrl: "https://api.github.com",
        githubUserAgent: "mergewise-worker-test",
        githubRequestTimeoutMs: 1000,
        githubFetchRetries: 2,
        githubRetryDelayMs: 10,
        confidenceThreshold: 0.78,
        maxComments: 20,
        testFileConfidenceThreshold: 0.98,
      }),
      loadMergewiseConfigFn: () => ({
        gating: { confidenceThreshold: 0.8, maxComments: 10 },
        rules: { include: [], exclude: [] },
        review: { skipPatterns: [] },
        llm: {
          enabled: false, model: "gpt-4o", ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000, baseUrl: "https://api.openai.com/v1", consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => [indexJob],
      processAnalyzePullRequestJobFn: async () => ({} as never),
      openDebtStoreFn: () => { throw new Error("SQLite init failed"); },
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => ({
        start: () => {
          intervalCallbacks.push(() => { pollCycle().then(() => undefined, () => undefined); });
        },
        stop: async () => {},
        isRunning: () => true,
      }),
      registerSignalHandlerFn: () => {},
      logInfo: (message) => { infoLogs.push(message); },
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await Promise.resolve();

    const skipCount = infoLogs.filter((log) => log.includes("skipping index job=idx-2")).length;
    expect(skipCount).toBe(1);
    expect(infoLogs.some((log) => log.includes("debt store unavailable"))).toBe(true);

    runPollCycle?.();
    await Promise.resolve();
    const skipCountAfterSecondPoll = infoLogs.filter((log) => log.includes("skipping index job=idx-2")).length;
    expect(skipCountAfterSecondPoll).toBe(1);

    await processHandle.shutdown();
  });

  test("continues startup when debt store open fails", () => {
    const errorLogs: string[] = [];

    const processHandle = startWorkerProcess({
      loadConfigFn: () => ({
        pollIntervalMs: 3000,
        maxProcessedKeys: 1000,
        githubApiBaseUrl: "https://api.github.com",
        githubUserAgent: "mergewise-worker-test",
        githubRequestTimeoutMs: 1000,
        githubFetchRetries: 2,
        githubRetryDelayMs: 10,
        confidenceThreshold: 0.78,
        maxComments: 20,
        testFileConfidenceThreshold: 0.98,
      }),
      loadMergewiseConfigFn: () => ({
        gating: { confidenceThreshold: 0.8, maxComments: 10 },
        rules: { include: [], exclude: [] },
        review: { skipPatterns: [] },
        llm: {
          enabled: false, model: "gpt-4o", ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000, baseUrl: "https://api.openai.com/v1", consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => [],
      processAnalyzePullRequestJobFn: async () => ({} as never),
      openDebtStoreFn: () => { throw new Error("disk full"); },
      createPollingLoopControllerFn: () => ({
        start: () => {},
        stop: async () => {},
        isRunning: () => true,
      }),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: (message) => { errorLogs.push(message); },
    });

    expect(errorLogs.some((log) => log.includes("debt_store_open_failed"))).toBe(true);
    expect(errorLogs.some((log) => log.includes("disk full"))).toBe(true);
    expect(processHandle.shutdown).toBeDefined();
  });
});
