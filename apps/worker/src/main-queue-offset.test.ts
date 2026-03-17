import { describe, expect, test } from "bun:test";

import { startWorkerProcess } from "./main";
import { toPRNumber } from "@mergewise/shared-types";
import { createAnalyzeJob, createFeedbackJob } from "./test-helpers";

const DEFAULT_LLM_MODELS = { triageModel: "gpt-4.1-mini", criticModel: "gpt-4.1-mini", usePipeline: true };

function makeWorkerConfig() {
  return {
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
  };
}

function makeMergewiseConfig() {
  return {
    gating: { confidenceThreshold: 0.8, maxComments: 10 },
    rules: { include: [] as string[], exclude: [] as string[] },
    review: { skipPatterns: [] as string[] },
    llm: {
      enabled: false,
      model: "gpt-4o",
      ...DEFAULT_LLM_MODELS,
      tokenBudget: 30_000,
      baseUrl: "https://api.openai.com/v1",
      consistencySamples: 1,
    },
  };
}

function makeJobResult(job: { job_id: string; repo_full_name: string; pr_number: number; head_sha: string; trace_id?: string | undefined }) {
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
    failedRuleIds: [] as string[],
    processedAt: "2026-01-01T00:00:00.000Z",
    traceId: job.trace_id ?? job.job_id,
  };
}

function makePollingController(intervalCallbacks: (() => void)[]) {
  return (_pollIntervalMs: number, pollCycle: () => Promise<void>) => ({
    start: () => {
      intervalCallbacks.push(() => { pollCycle().then(() => undefined, () => undefined); });
    },
    stop: async () => {},
    isRunning: () => true,
  });
}

const drainMicrotasks = (): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, 0); });

describe("startWorkerProcess queue offset", () => {
  test("persists byte offset after poll cycle and skips already-read jobs on restart", async () => {
    const processedJobIds: string[] = [];
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];
    let pollCallCount = 0;
    const persistByteOffsetJob = createAnalyzeJob({ queued_at: "2026-02-01T00:00:00.000Z" });

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => { writtenOffsets.push(offset); },
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        pollCallCount++;
        if (offset === 0) {
          return { jobs: [persistByteOffsetJob], byteOffset: 150 };
        }
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        processedJobIds.push(job.job_id);
        return makeJobResult(job);
      },
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(processedJobIds).toContain(persistByteOffsetJob.job_id);
    expect(writtenOffsets).toEqual([150]);

    runPollCycle?.();
    await drainMicrotasks();

    expect(processedJobIds).toContain(persistByteOffsetJob.job_id);
    expect(pollCallCount).toBe(2);

    await processHandle.shutdown();

    const restartIntervalCallbacks: (() => void)[] = [];
    let restartReadOffset: number | undefined;
    const restartProcessedJobIds: string[] = [];

    const restartHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => writtenOffsets[0] ?? 0,
      writeQueueOffsetFn: () => {},
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        restartReadOffset = offset;
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        restartProcessedJobIds.push(job.job_id);
        return makeJobResult(job);
      },
      createPollingLoopControllerFn: makePollingController(restartIntervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runRestartPollCycle] = restartIntervalCallbacks;
    runRestartPollCycle?.();
    await drainMicrotasks();

    expect(restartReadOffset).toBe(150);
    expect(restartProcessedJobIds).toEqual([]);

    await restartHandle.shutdown();
  });

  test("does not persist offset when no new data was read", async () => {
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => 500,
      writeQueueOffsetFn: (_path, offset) => { writtenOffsets.push(offset); },
      readAllQueueJobsFn: async () => ({ jobs: [], byteOffset: 500 }),
      processAnalyzePullRequestJobFn: async () => { throw new Error("should not run"); },
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(writtenOffsets).toEqual([]);

    await processHandle.shutdown();
  });

  test("falls back to offset 0 when readQueueOffsetFn throws", async () => {
    const processedJobIds: string[] = [];
    const intervalCallbacks: (() => void)[] = [];
    let readByteOffset: number | undefined;
    const fallbackJob = createAnalyzeJob({ queued_at: "2026-01-01T00:00:00.000Z" });

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => { throw new Error("corrupt offset file"); },
      writeQueueOffsetFn: () => {},
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        readByteOffset = offset;
        if (offset === 0) {
          return { jobs: [fallbackJob], byteOffset: 50 };
        }
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        processedJobIds.push(job.job_id);
        return makeJobResult(job);
      },
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(readByteOffset).toBe(0);
    expect(processedJobIds).toContain(fallbackJob.job_id);

    await processHandle.shutdown();
  });

  test("retries offset write on transient failure", async () => {
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];
    let writeAttempts = 0;
    const retryJob = createAnalyzeJob({ queued_at: "2026-01-01T00:00:00.000Z" });

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => {
        writeAttempts++;
        if (writeAttempts <= 2) {
          throw new Error("disk full");
        }
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async () => ({ jobs: [retryJob], byteOffset: 200 }),
      processAnalyzePullRequestJobFn: async (job) => makeJobResult(job),
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const drainWithRetryDelay = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 200); });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainWithRetryDelay();

    expect(writeAttempts).toBe(3);
    expect(writtenOffsets).toEqual([200]);

    await processHandle.shutdown();
  });

  test("does not advance offset when a job in the batch fails", async () => {
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];
    const okJob = createAnalyzeJob({ pr_number: toPRNumber(1), queued_at: "2026-01-01T00:00:00.000Z" });
    const failJob = createAnalyzeJob({ pr_number: toPRNumber(2), queued_at: "2026-01-01T00:00:00.000Z" });

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => { writtenOffsets.push(offset); },
      readAllQueueJobsFn: async () => ({ jobs: [okJob, failJob], byteOffset: 300 }),
      processAnalyzePullRequestJobFn: async (job) => {
        if (job.job_id === failJob.job_id) {
          throw new Error("processing failed");
        }
        return makeJobResult(job);
      },
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(writtenOffsets).toEqual([]);

    await processHandle.shutdown();
  });

  test("does not advance offset when a feedback job in the batch fails", async () => {
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];
    const feedbackFailJob = createFeedbackJob({ queued_at: "2026-02-01T00:00:00.000Z" });

    const processHandle = startWorkerProcess({
      loadConfigFn: () => makeWorkerConfig(),
      loadMergewiseConfigFn: () => makeMergewiseConfig(),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => { writtenOffsets.push(offset); },
      readAllQueueJobsFn: async () => ({ jobs: [feedbackFailJob], byteOffset: 200 }),
      processAnalyzePullRequestJobFn: async () => { throw new Error("should not run"); },
      processCollectFeedbackJobFn: async () => { throw new Error("feedback collection failed"); },
      createPollingLoopControllerFn: makePollingController(intervalCallbacks),
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: () => {},
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(writtenOffsets).toEqual([]);

    await processHandle.shutdown();
  });
});
