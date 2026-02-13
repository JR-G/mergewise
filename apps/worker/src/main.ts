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
  trackProcessedKey,
} from "./index";

const config = loadConfig();
const state = createProcessedKeyState();
let isPollInFlight = false;

console.log(
  `[worker] started (poll=${config.pollIntervalMs}ms, max_keys=${config.maxProcessedKeys}, source=${DEFAULT_JOB_FILE_PATH})`,
);

async function pollAndProcessJobs(): Promise<void> {
  if (isPollInFlight) {
    return;
  }

  isPollInFlight = true;
  try {
    let jobs: AnalyzePullRequestJob[];
    try {
      jobs = readAllAnalyzePullRequestJobs();
    } catch (error) {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`[worker] failed to read queued jobs: ${details}`);
      return;
    }

    for (const job of jobs) {
      const key = buildIdempotencyKey(job);
      if (state.keys.has(key)) {
        continue;
      }

      try {
        const summary = await processAnalyzePullRequestJob(job);
        if (!summary) {
          continue;
        }
        trackProcessedKey(key, state, config.maxProcessedKeys);
      } catch (error) {
        const details = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`[worker] failed to process job=${job.job_id}: ${details}`);
      }
    }
  } finally {
    isPollInFlight = false;
  }
}

setInterval(() => {
  void pollAndProcessJobs();
}, config.pollIntervalMs);
