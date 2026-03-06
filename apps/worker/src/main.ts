import {
  DEFAULT_JOB_FILE_PATH,
  deriveOffsetFilePath,
  isCollectFeedbackJob,
  readAllQueueJobs,
  readQueueOffset,
  writeQueueOffset,
} from "@mergewise/job-store";
import { loadMergewiseConfig } from "@mergewise/config-loader";
import { openFeedbackStore, type FeedbackStore } from "@mergewise/feedback-store";
import type { CollectFeedbackJob } from "@mergewise/shared-types";

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
import { processCollectFeedbackJob } from "./process-feedback-job";

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
  readonly readAllQueueJobsFn?: typeof readAllQueueJobs;
  /**
   * Analysis job processing implementation.
   */
  readonly processAnalyzePullRequestJobFn?: typeof processAnalyzePullRequestJob;
  /**
   * Feedback job processing implementation.
   */
  readonly processCollectFeedbackJobFn?: typeof processCollectFeedbackJob;
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
   * Queue offset reader for resuming from the last read position.
   */
  readonly readQueueOffsetFn?: typeof readQueueOffset;
  /**
   * Queue offset writer for persisting the current read position.
   */
  readonly writeQueueOffsetFn?: typeof writeQueueOffset;
  /**
   * Feedback store factory override for testing.
   */
  readonly openFeedbackStoreFn?: () => FeedbackStore;
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
      .catch((error: unknown) => {
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
  const readAllQueueJobsFn = dependencies.readAllQueueJobsFn ?? readAllQueueJobs;
  const processAnalyzePullRequestJobFn =
    dependencies.processAnalyzePullRequestJobFn ?? processAnalyzePullRequestJob;
  const processCollectFeedbackJobFn =
    dependencies.processCollectFeedbackJobFn ?? processCollectFeedbackJob;
  const createPollingLoopControllerFn =
    dependencies.createPollingLoopControllerFn ?? createPollingLoopController;
  const readQueueOffsetFn = dependencies.readQueueOffsetFn ?? readQueueOffset;
  const writeQueueOffsetFn = dependencies.writeQueueOffsetFn ?? writeQueueOffset;
  const registerSignalHandlerFn =
    dependencies.registerSignalHandlerFn ??
    ((signal, listener) => process.on(signal, listener));
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;

  const config = loadConfigFn();
  const mergewiseConfig = loadMergewiseConfigFn();
  const openFeedbackStoreFn = dependencies.openFeedbackStoreFn ?? openFeedbackStore;
  let feedbackStore: FeedbackStore;
  try {
    feedbackStore = openFeedbackStoreFn();
  } catch (storeError) {
    const details = storeError instanceof Error ? storeError.stack ?? storeError.message : String(storeError);
    errorLogger(`[worker] feedback_store_open_failed: ${details}`);
    throw storeError;
  }
  const processedKeyState = createProcessedKeyState();
  const pollCycleState = { isPollInFlight: false };
  const offsetFilePath = deriveOffsetFilePath(DEFAULT_JOB_FILE_PATH);
  let currentByteOffset = readQueueOffsetFn(offsetFilePath);

  const pollAndProcessJobs = async (): Promise<void> => {
    const didRun = await runPollCycleWithInFlightGuard(pollCycleState, async () => {
      let readResult: Awaited<ReturnType<typeof readAllQueueJobs>>;
      try {
        readResult = await readAllQueueJobsFn(undefined, undefined, currentByteOffset);
      } catch (error) {
        const details = error instanceof Error ? error.stack ?? error.message : String(error);
        errorLogger(`[worker] failed to read queued jobs: ${details}`);
        return;
      }

      const { jobs: queuedJobs, byteOffset: newByteOffset } = readResult;

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
        if (isCollectFeedbackJob(queuedJob)) {
          await processFeedbackJobEntry(
            queuedJob, processedKeyState, config.maxProcessedKeys,
            processCollectFeedbackJobFn, feedbackStore, githubFetchOptions,
            infoLogger, errorLogger,
          );
          continue;
        }

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
            feedbackStore,
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

      if (newByteOffset !== currentByteOffset) {
        currentByteOffset = newByteOffset;
        try {
          writeQueueOffsetFn(offsetFilePath, currentByteOffset);
        } catch (writeError) {
          const details = writeError instanceof Error ? writeError.message : String(writeError);
          errorLogger(`[worker] failed to write queue offset: ${details}`);
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
  const closeFeedbackStore = (): void => {
    try {
      feedbackStore.close();
    } catch (closeError) {
      const details = closeError instanceof Error ? closeError.message : String(closeError);
      errorLogger(`[worker] feedback_store_close_failed: ${details}`);
    }
  };

  const shutdownSignalHandler = createShutdownSignalHandler({
    shutdown: async () => {
      await pollingLoop.stop();
      closeFeedbackStore();
    },
    logInfo: infoLogger,
    logError: errorLogger,
  });

  infoLogger(
    `[worker] started (poll=${config.pollIntervalMs}ms, max_keys=${config.maxProcessedKeys}, source=${DEFAULT_JOB_FILE_PATH}, offset=${currentByteOffset})`,
  );
  pollingLoop.start();
  registerSignalHandlerFn("SIGTERM", shutdownSignalHandler);
  registerSignalHandlerFn("SIGINT", shutdownSignalHandler);

  return {
    shutdown: async () => {
      await pollingLoop.stop();
      closeFeedbackStore();
    },
    handleSignal: shutdownSignalHandler,
  };
}

async function processFeedbackJobEntry(
  queuedJob: CollectFeedbackJob,
  processedKeyState: ReturnType<typeof createProcessedKeyState>,
  maxProcessedKeys: number,
  processCollectFeedbackJobFn: typeof processCollectFeedbackJob,
  feedbackStore: FeedbackStore,
  githubFetchOptions: WorkerGitHubFetchOptions,
  infoLogger: (message: string) => void,
  errorLogger: (message: string) => void,
): Promise<void> {
  const feedbackIdempotencyKey = `feedback:${queuedJob.repo_full_name}#${queuedJob.pr_number}@${queuedJob.queued_at}`;
  if (processedKeyState.keys.has(feedbackIdempotencyKey)) {
    return;
  }

  try {
    await processCollectFeedbackJobFn(queuedJob, {
      feedbackStore,
      githubFetchOptions,
      logInfo: infoLogger,
      logError: errorLogger,
    });
    trackProcessedKey(feedbackIdempotencyKey, processedKeyState, maxProcessedKeys);
  } catch (error) {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    errorLogger(
      `[worker] failed to process feedback job=${queuedJob.job_id}: ${details}`,
    );
  }
}

if (import.meta.main) {
  startWorkerProcess();
}
