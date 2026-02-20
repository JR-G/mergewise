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
  resolveJobTraceId,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
  type PollingLoopController,
  type WorkerConfig,
  type WorkerFindingDeliveryOptions,
  type WorkerGitHubFetchOptions,
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
 * Dependencies for worker process startup wiring.
 */
export interface StartWorkerProcessDependencies {
  /**
   * Worker runtime configuration loader.
   */
  readonly loadConfigFn?: () => WorkerConfig;
  /**
   * Mergewise runtime config loader.
   */
  readonly loadMergewiseConfigFn?: typeof loadMergewiseConfig;
  /**
   * Queue reader implementation.
   */
  readonly readAllAnalyzePullRequestJobsFn?: typeof readAllAnalyzePullRequestJobs;
  /**
   * Job processing implementation.
   */
  readonly processAnalyzePullRequestJobFn?: typeof processAnalyzePullRequestJob;
  /**
   * Polling loop constructor.
   */
  readonly createPollingLoopControllerFn?: (
    pollIntervalMs: number,
    pollCycle: () => Promise<void>,
    dependencies: { readonly logError?: (message: string) => void },
  ) => PollingLoopController;
  /**
   * Signal registration implementation.
   */
  readonly registerSignalHandlerFn?: (
    signal: WorkerShutdownSignal,
    listener: (signal: WorkerShutdownSignal) => void,
  ) => void;
  /**
   * Info logger for startup and lifecycle events.
   */
  readonly logInfo?: (message: string) => void;
  /**
   * Error logger for runtime failures.
   */
  readonly logError?: (message: string) => void;
}

/**
 * Runtime handles returned by worker startup.
 */
export interface StartedWorkerProcess {
  /**
   * Graceful shutdown hook for tests and orchestration.
   */
  readonly shutdown: () => Promise<void>;
  /**
   * Signal entrypoint used for graceful termination.
   */
  readonly handleSignal: (signal: WorkerShutdownSignal) => void;
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
export function startWorkerProcess(
  dependencies: StartWorkerProcessDependencies = {},
): StartedWorkerProcess {
  const loadConfigFn = dependencies.loadConfigFn ?? loadConfig;
  const loadMergewiseConfigFn = dependencies.loadMergewiseConfigFn ?? loadMergewiseConfig;
  const readAllAnalyzePullRequestJobsFn =
    dependencies.readAllAnalyzePullRequestJobsFn ?? readAllAnalyzePullRequestJobs;
  const processAnalyzePullRequestJobFn =
    dependencies.processAnalyzePullRequestJobFn ?? processAnalyzePullRequestJob;
  const createPollingLoopControllerFn =
    dependencies.createPollingLoopControllerFn ?? createPollingLoopController;
  const registerSignalHandlerFn =
    dependencies.registerSignalHandlerFn ??
    ((signal, listener) => process.on(signal, listener));
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;

  const config = loadConfigFn();
  const mergewiseConfig = loadMergewiseConfigFn();
  const processedKeyState = createProcessedKeyState();
  const pollCycleState = { isPollInFlight: false };

  const pollAndProcessJobs = async (): Promise<void> => {
    const didRun = await runPollCycleWithInFlightGuard(pollCycleState, async () => {
      let queuedJobs: AnalyzePullRequestJob[];
      try {
        queuedJobs = readAllAnalyzePullRequestJobsFn();
      } catch (error) {
        const details = error instanceof Error ? error.stack ?? error.message : String(error);
        errorLogger(`[worker] failed to read queued jobs: ${details}`);
        return;
      }

      const findingDeliveryOptions: WorkerFindingDeliveryOptions = {
        confidenceThreshold: mergewiseConfig.gating.confidenceThreshold,
        maxComments: mergewiseConfig.gating.maxComments,
        testFileConfidenceThreshold: config.testFileConfidenceThreshold,
      };
      const githubFetchOptions: WorkerGitHubFetchOptions = {
        githubApiBaseUrl: config.githubApiBaseUrl,
        githubUserAgent: config.githubUserAgent,
        githubRequestTimeoutMs: config.githubRequestTimeoutMs,
        githubFetchRetries: config.githubFetchRetries,
        githubRetryDelayMs: config.githubRetryDelayMs,
      };

      for (const queuedJob of queuedJobs) {
        const idempotencyKey = buildIdempotencyKey(queuedJob);
        if (processedKeyState.keys.has(idempotencyKey)) {
          continue;
        }

        try {
          await processAnalyzePullRequestJobFn(queuedJob, {
            deliveryMode: "github",
            findingDeliveryOptions,
            mergewiseConfig,
            githubFetchOptions,
          });
          trackProcessedKey(idempotencyKey, processedKeyState, config.maxProcessedKeys);
        } catch (error) {
          const details = error instanceof Error ? error.stack ?? error.message : String(error);
          const traceId = resolveJobTraceId(queuedJob);
          errorLogger(
            `[worker] failed to process trace=${traceId} job=${queuedJob.job_id}: ${details}`,
          );
        }
      }
    });

    if (!didRun) {
      infoLogger("[worker] poll skipped: previous cycle still in flight");
    }
  };

  const pollingLoop = createPollingLoopControllerFn(config.pollIntervalMs, pollAndProcessJobs, {
    logError: errorLogger,
  });
  const shutdownSignalHandler = createShutdownSignalHandler({
    shutdown: () => pollingLoop.stop(),
    logInfo: infoLogger,
    logError: errorLogger,
  });

  infoLogger(
    `[worker] started (poll=${config.pollIntervalMs}ms, max_keys=${config.maxProcessedKeys}, source=${DEFAULT_JOB_FILE_PATH})`,
  );
  pollingLoop.start();
  registerSignalHandlerFn("SIGTERM", shutdownSignalHandler);
  registerSignalHandlerFn("SIGINT", shutdownSignalHandler);

  return {
    shutdown: () => pollingLoop.stop(),
    handleSignal: shutdownSignalHandler,
  };
}

if (import.meta.main) {
  startWorkerProcess();
}
