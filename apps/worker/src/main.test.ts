import { describe, expect, test } from "bun:test";

import {
  createShutdownSignalHandler,
  startWorkerProcess,
  type WorkerShutdownSignal,
} from "./main";
import { createAnalyzeJob } from "./test-helpers";

const DEFAULT_LLM_MODELS = { triageModel: "gpt-4.1-mini", criticModel: "gpt-4.1-mini", usePipeline: true };

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
        review: { skipPatterns: [], agentFriendliness: false },
        llm: {
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => ({ jobs: [], byteOffset: 0 }),
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
        review: { skipPatterns: [], agentFriendliness: false },
        llm: {
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => ({ jobs: queuedJobs, byteOffset: 500 }),
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
        review: { skipPatterns: [], agentFriendliness: false },
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
        review: { skipPatterns: [], agentFriendliness: false },
        llm: {
          enabled: false,
          model: "gpt-4o",
          ...DEFAULT_LLM_MODELS,
          tokenBudget: 30_000,
          baseUrl: "https://api.openai.com/v1",
          consistencySamples: 1,
        },
      }),
      readAllQueueJobsFn: async () => ({ jobs: [queuedJob], byteOffset: 100 }),
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
          review: { skipPatterns: [], agentFriendliness: false },
          llm: {
            enabled: false,
            model: "gpt-4o",
            ...DEFAULT_LLM_MODELS,
            tokenBudget: 30_000,
            baseUrl: "https://api.openai.com/v1",
            consistencySamples: 1,
          },
        }),
        readAllQueueJobsFn: async () => ({ jobs: [], byteOffset: 0 }),
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

});
