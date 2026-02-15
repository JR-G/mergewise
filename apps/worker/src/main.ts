import {
  DEFAULT_JOB_FILE_PATH,
  readAllAnalyzePullRequestJobs,
} from "@mergewise/job-store";
import { loadMergewiseConfig } from "@mergewise/config-loader";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

import {
  buildIdempotencyKey,
  createPollingLoopController,
  createProcessedKeyState,
  loadConfig,
  processAnalyzePullRequestJob,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
} from "./index";

/**
 * Supported shutdown signals for graceful worker termination.
 */
export type WorkerShutdownSignal = "SIGTERM" | "SIGINT";

/**
 * Dependencies for creating signal-driven worker shutdown handlers.
 */
export interface WorkerShutdownSignalHandlerDependencies {
  /**
   * Shutdown action that stops polling and waits for in-flight work.
   */
  readonly shutdown: () => Promise<void>;
  /**
   * Process-exit function override for tests.
   */
  readonly exitFn?: (exitCode: number) => void;
  /**
   * Info logger for lifecycle events.
   */
  readonly logInfo?: (message: string) => void;
  /**
   * Error logger for shutdown failures.
   */
  readonly logError?: (message: string) => void;
}

/**
 * Creates an idempotent shutdown signal handler.
 *
 * @remarks
 * Repeated signals reuse the first in-flight shutdown request.
 *
 * @param dependencies - Shutdown and logging dependencies.
 * @returns Signal handler for `SIGTERM` and `SIGINT`.
 */
export function createShutdownSignalHandler(
  dependencies: WorkerShutdownSignalHandlerDependencies,
): (signal: WorkerShutdownSignal) => void {
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;
  const exitFn = dependencies.exitFn ?? ((exitCode: number) => process.exit(exitCode));
  let shutdownPromise: Promise<void> | null = null;

  return (signal: WorkerShutdownSignal): void => {
    if (shutdownPromise !== null) {
      return;
    }

    infoLogger(`[worker] shutdown signal received: ${signal}`);
    shutdownPromise = dependencies.shutdown()
      .then(() => {
        infoLogger(`[worker] graceful shutdown complete: ${signal}`);
        exitFn(0);
      })
      .catch((error) => {
        const details = error instanceof Error ? error.stack ?? error.message : String(error);
        errorLogger(`[worker] graceful shutdown failed: ${details}`);
        exitFn(1);
      });
  };
}

/**
 * Starts the worker polling process and installs graceful shutdown handlers.
 */
export function startWorkerProcess(): void {
  const config = loadConfig();
  const mergewiseConfig = loadMergewiseConfig();
  const processedKeyState = createProcessedKeyState();
  const pollCycleState = { isPollInFlight: false };
  const errorLogger = console.error;

  const pollAndProcessJobs = async (): Promise<void> => {
    const didRun = await runPollCycleWithInFlightGuard(pollCycleState, async () => {
      let queuedJobs: AnalyzePullRequestJob[];
      try {
        queuedJobs = readAllAnalyzePullRequestJobs();
      } catch (error) {
        const details = error instanceof Error ? error.stack ?? error.message : String(error);
        errorLogger(`[worker] failed to read queued jobs: ${details}`);
        return;
      }

      for (const queuedJob of queuedJobs) {
        const idempotencyKey = buildIdempotencyKey(queuedJob);
        if (processedKeyState.keys.has(idempotencyKey)) {
          continue;
        }

        try {
          await processAnalyzePullRequestJob(queuedJob, {
            deliveryMode: "github",
            findingDeliveryOptions: {
              confidenceThreshold: mergewiseConfig.gating.confidenceThreshold,
              maxComments: mergewiseConfig.gating.maxComments,
            },
            mergewiseConfig,
            githubFetchOptions: {
              githubApiBaseUrl: config.githubApiBaseUrl,
              githubUserAgent: config.githubUserAgent,
              githubRequestTimeoutMs: config.githubRequestTimeoutMs,
              githubFetchRetries: config.githubFetchRetries,
              githubRetryDelayMs: config.githubRetryDelayMs,
            },
          });
          trackProcessedKey(idempotencyKey, processedKeyState, config.maxProcessedKeys);
        } catch (error) {
          const details = error instanceof Error ? error.stack ?? error.message : String(error);
          errorLogger(`[worker] failed to process job=${queuedJob.job_id}: ${details}`);
        }
      }
    });

    if (!didRun) {
      console.log("[worker] poll skipped: previous cycle still in flight");
    }
  };

  const pollingLoop = createPollingLoopController(config.pollIntervalMs, pollAndProcessJobs, {
    logError: errorLogger,
  });
  const shutdownSignalHandler = createShutdownSignalHandler({
    shutdown: () => pollingLoop.stop(),
    logInfo: console.log,
    logError: errorLogger,
  });

  console.log(
    `[worker] started (poll=${config.pollIntervalMs}ms, max_keys=${config.maxProcessedKeys}, source=${DEFAULT_JOB_FILE_PATH})`,
  );
  pollingLoop.start();
  process.on("SIGTERM", shutdownSignalHandler);
  process.on("SIGINT", shutdownSignalHandler);
}

if (import.meta.main) {
  startWorkerProcess();
}
