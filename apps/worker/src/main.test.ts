import { describe, expect, test } from "bun:test";

import {
  createShutdownSignalHandler,
  startWorkerProcess,
  type WorkerShutdownSignal,
} from "./main";
import { toPRNumber } from "@mergewise/shared-types";
import { createAnalyzeJob, createFeedbackJob } from "./test-helpers";

const DEFAULT_LLM_MODELS = { triageModel: "gpt-4o-mini", criticModel: "gpt-4o-mini", usePipeline: true };

function invokeSignalHandler(
  handler: (signal: WorkerShutdownSignal) => void,
  signal: WorkerShutdownSignal,
): void {
  handler(signal);
}

describe("createShutdownSignalHandler", () => {
  test("handles repeated signals with one shutdown execution", async () => {
    let shutdownCallCount = 0;
    const exitCodes: number[] = [];
    let resolveShutdown: () => void = () => {};
    const shutdownStarted = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const signalHandler = createShutdownSignalHandler({
      shutdown: async () => {
        shutdownCallCount += 1;
        await shutdownStarted;
      },
      exitFn: (exitCode) => {
        exitCodes.push(exitCode);
      },
      logInfo: () => {},
      logError: () => {},
    });

    invokeSignalHandler(signalHandler, "SIGTERM");
    invokeSignalHandler(signalHandler, "SIGINT");
    await Promise.resolve();
    expect(shutdownCallCount).toBe(1);
    expect(exitCodes).toEqual([]);

    resolveShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitCodes).toEqual([0]);
  });

  test("exits with failure code when shutdown throws an invalid state", async () => {
    const exitCodes: number[] = [];
    const signalHandler = createShutdownSignalHandler({
      shutdown: async () => {
        throw new Error("shutdown failed");
      },
      exitFn: (exitCode) => {
        exitCodes.push(exitCode);
      },
      logInfo: () => {},
      logError: () => {},
    });

    invokeSignalHandler(signalHandler, "SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });
});

describe("startWorkerProcess", () => {
  test("starts polling and registers SIGTERM and SIGINT handlers", async () => {
    const registeredSignals: WorkerShutdownSignal[] = [];
    const startCalls: number[] = [];
    const shutdownCalls: number[] = [];

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
      readAllQueueJobsFn: async () => [],
      processAnalyzePullRequestJobFn: async () => {
        throw new Error("should not run");
      },
      createPollingLoopControllerFn: () => ({
        start: () => {
          startCalls.push(1);
        },
        stop: async () => {
          shutdownCalls.push(1);
        },
        isRunning: () => true,
      }),
      registerSignalHandlerFn: (signal) => {
        registeredSignals.push(signal);
      },
      logInfo: () => {},
      logError: () => {},
    });

    expect(startCalls).toEqual([1]);
    expect(registeredSignals).toEqual(["SIGTERM", "SIGINT"]);
    await processHandle.shutdown();
    expect(shutdownCalls).toEqual([1]);
  });

  test("poll cycle reads queue, processes once per idempotency key, and logs read failures", async () => {
    const baseJob = createAnalyzeJob({ queued_at: "2026-02-01T00:00:00.000Z" });
    const queuedJobs = [
      baseJob,
      createAnalyzeJob({
        repo_full_name: baseJob.repo_full_name,
        pr_number: baseJob.pr_number,
        head_sha: baseJob.head_sha,
        queued_at: "2026-02-01T00:01:00.000Z",
      }),
    ];
    const processedJobIds: string[] = [];
    const errorLogs: string[] = [];
    const intervalCallbacks: (() => void)[] = [];

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
      readAllQueueJobsFn: async () => queuedJobs,
      processAnalyzePullRequestJobFn: async (job) => {
        processedJobIds.push(job.job_id);
        return {
          jobId: job.job_id,
          idempotencyKey: `${job.repo_full_name}#${job.pr_number}@${job.head_sha}`,
          repository: job.repo_full_name,
          pullRequestNumber: job.pr_number,
          headSha: job.head_sha,
          totalFindings: 0,
          findingsByCategory: {
            clean: 0,
            perf: 0,
            safety: 0,
            idiomatic: 0,
          },
          totalRules: 0,
          successfulRules: 0,
          failedRules: 0,
          failedRuleIds: [],
          processedAt: "2026-02-01T00:00:00.000Z",
          traceId: job.trace_id ?? job.job_id,
        };
      },
      createPollingLoopControllerFn: (pollIntervalMs, pollCycle, dependencies) => {
        return {
          start: () => {
            dependencies.logError?.(`interval:${pollIntervalMs}`);
            intervalCallbacks.push(() => {
              pollCycle().then(() => undefined, () => undefined);
            });
          },
          stop: async () => {},
          isRunning: () => true,
        };
      },
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: (message) => {
        errorLogs.push(message);
      },
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await Promise.resolve();
    expect(processedJobIds).toEqual([baseJob.job_id]);
    expect(errorLogs[0]).toBe("interval:3000");

    const failingWorker = startWorkerProcess({
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
      readAllQueueJobsFn: async () => {
        throw new Error("queue read failed");
      },
      processAnalyzePullRequestJobFn: async () => {
        throw new Error("should not run");
      },
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => {
        return {
          start: () => {
            intervalCallbacks.push(() => {
              pollCycle().then(() => undefined, () => undefined);
            });
          },
          stop: async () => {},
          isRunning: () => true,
        };
      },
      registerSignalHandlerFn: () => {},
      logInfo: () => {},
      logError: (message) => {
        errorLogs.push(message);
      },
    });

    const [, runFailingPollCycle] = intervalCallbacks;
    runFailingPollCycle?.();
    await Promise.resolve();
    expect(errorLogs.some((message) => message.includes("failed to read queued jobs"))).toBe(true);

    await processHandle.shutdown();
    await failingWorker.shutdown();
  });

  test("logs per-job failures and overlapping poll-cycle skips", async () => {
    const queuedJob = createAnalyzeJob({ queued_at: "2026-02-01T00:00:00.000Z" });
    const infoLogs: string[] = [];
    const errorLogs: string[] = [];
    const intervalCallbacks: (() => void)[] = [];
    let releaseProcessing: () => void = () => {};
    const processingGate = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    const workerHandle = startWorkerProcess({
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
      readAllQueueJobsFn: async () => [queuedJob],
      processAnalyzePullRequestJobFn: async () => {
        await processingGate;
        throw new Error("processing failed");
      },
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => {
        return {
          start: () => {
            intervalCallbacks.push(() => {
              pollCycle().then(() => undefined, () => undefined);
            });
          },
          stop: async () => {},
          isRunning: () => true,
        };
      },
      registerSignalHandlerFn: () => {},
      logInfo: (message) => {
        infoLogs.push(message);
      },
      logError: (message) => {
        errorLogs.push(message);
      },
    });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    runPollCycle?.();
    await Promise.resolve();
    releaseProcessing();
    await Promise.resolve();
    await Promise.resolve();

    expect(
      infoLogs.some((message) => message.includes("poll skipped: previous cycle still in flight")),
    ).toBe(true);
    expect(
      errorLogs.some((message) =>
        message.includes(`failed to process trace=${queuedJob.job_id} job=${queuedJob.job_id}`),
      ),
    ).toBe(true);

    await workerHandle.shutdown();
  });

  test("uses default process signal registration and default exit wiring", async () => {
    const originalProcessOn = process.on;
    const originalProcessExit = process.exit;
    const registeredSignals: WorkerShutdownSignal[] = [];
    const registeredSignalHandlers: ((signal: WorkerShutdownSignal) => void)[] = [];
    const exitCodes: number[] = [];

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- SignalsListener is the correct type for this mock
    process.on = ((signal: NodeJS.Signals, listener: NodeJS.SignalsListener) => {
      registeredSignals.push(signal as WorkerShutdownSignal);
      registeredSignalHandlers.push(listener as (signal: WorkerShutdownSignal) => void);
      return process;
    }) as typeof process.on;
    process.exit = ((exitCode?: number) => {
      exitCodes.push(exitCode ?? 0);
      return undefined as never;
    }) as typeof process.exit;

    try {
      startWorkerProcess({
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
        readAllQueueJobsFn: async () => [],
        processAnalyzePullRequestJobFn: async () => {
          throw new Error("should not run");
        },
        createPollingLoopControllerFn: () => ({
          start: () => {},
          stop: async () => {},
          isRunning: () => true,
        }),
        logInfo: () => {},
        logError: () => {},
      });

      expect(registeredSignals).toEqual(["SIGTERM", "SIGINT"]);
      const [firstSignalHandler] = registeredSignalHandlers;
      firstSignalHandler?.("SIGTERM");
      await Promise.resolve();
      await Promise.resolve();
      expect(exitCodes).toEqual([0]);
    } finally {
      process.on = originalProcessOn;
      process.exit = originalProcessExit;
    }
  });

  test("persists byte offset after poll cycle and skips already-read jobs on restart", async () => {
    const processedJobIds: string[] = [];
    const writtenOffsets: number[] = [];
    const intervalCallbacks: (() => void)[] = [];
    let pollCallCount = 0;
    const persistByteOffsetJob = createAnalyzeJob({ queued_at: "2026-02-01T00:00:00.000Z" });

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
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => {
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        pollCallCount++;
        if (offset === 0) {
          return {
            jobs: [persistByteOffsetJob],
            byteOffset: 150,
          };
        }
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        processedJobIds.push(job.job_id);
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 0); });

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
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readQueueOffsetFn: () => writtenOffsets[0] ?? 0,
      writeQueueOffsetFn: () => {},
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        restartReadOffset = offset;
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        restartProcessedJobIds.push(job.job_id);
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
      createPollingLoopControllerFn: (_pollIntervalMs, pollCycle) => ({
        start: () => {
          restartIntervalCallbacks.push(() => {
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
      readQueueOffsetFn: () => 500,
      writeQueueOffsetFn: (_path, offset) => {
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async () => ({ jobs: [], byteOffset: 500 }),
      processAnalyzePullRequestJobFn: async () => {
        throw new Error("should not run");
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 0); });

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
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readQueueOffsetFn: () => { throw new Error("corrupt offset file"); },
      writeQueueOffsetFn: () => {},
      readAllQueueJobsFn: async (_filePath, _onSkipped, startByteOffset) => {
        const offset = startByteOffset ?? 0;
        readByteOffset = offset;
        if (offset === 0) {
          return {
            jobs: [fallbackJob],
            byteOffset: 50,
          };
        }
        return { jobs: [], byteOffset: offset };
      },
      processAnalyzePullRequestJobFn: async (job) => {
        processedJobIds.push(job.job_id);
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
          processedAt: "2026-01-01T00:00:00.000Z",
          traceId: job.job_id,
        };
      },
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 0); });

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
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => {
        writeAttempts++;
        if (writeAttempts <= 2) {
          throw new Error("disk full");
        }
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async () => ({
        jobs: [retryJob],
        byteOffset: 200,
      }),
      processAnalyzePullRequestJobFn: async (job) => ({
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
        processedAt: "2026-01-01T00:00:00.000Z",
        traceId: job.job_id,
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 200); });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

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
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => {
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async () => ({
        jobs: [okJob, failJob],
        byteOffset: 300,
      }),
      processAnalyzePullRequestJobFn: async (job) => {
        if (job.job_id === failJob.job_id) {
          throw new Error("processing failed");
        }
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
          processedAt: "2026-01-01T00:00:00.000Z",
          traceId: job.job_id,
        };
      },
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 0); });

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
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readQueueOffsetFn: () => 0,
      writeQueueOffsetFn: (_path, offset) => {
        writtenOffsets.push(offset);
      },
      readAllQueueJobsFn: async () => ({
        jobs: [feedbackFailJob],
        byteOffset: 200,
      }),
      processAnalyzePullRequestJobFn: async () => {
        throw new Error("should not run");
      },
      processCollectFeedbackJobFn: async () => {
        throw new Error("feedback collection failed");
      },
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

    const drainMicrotasks = (): Promise<void> =>
      new Promise((resolve) => { setTimeout(resolve, 0); });

    const [runPollCycle] = intervalCallbacks;
    runPollCycle?.();
    await drainMicrotasks();

    expect(writtenOffsets).toEqual([]);

    await processHandle.shutdown();
  });
});
