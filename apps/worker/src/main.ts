import {
  DEFAULT_JOB_FILE_PATH,
  readAllAnalyzePullRequestJobs,
} from "@mergewise/job-store";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

import {
  buildIdempotencyKey,
  createProcessedKeyState,
  loadConfig,
  processAnalyzePullRequestJob,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
} from "./index";

const config = loadConfig();
const processedKeyState = createProcessedKeyState();
const pollCycleState = { isPollInFlight: false };
const errorLogger = console.error;

console.log(
  `[worker] started (poll=${config.pollIntervalMs}ms, max_keys=${config.maxProcessedKeys}, source=${DEFAULT_JOB_FILE_PATH})`,
);

async function pollAndProcessJobs(): Promise<void> {
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
}

setInterval(() => {
  pollAndProcessJobs().catch((error) => {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    errorLogger(`[worker] poll cycle failed: ${details}`);
  });
}, config.pollIntervalMs);
