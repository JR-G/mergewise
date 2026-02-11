import {
  DEFAULT_JOB_FILE_PATH,
  readAllAnalyzePullRequestJobs,
} from "../../../packages/job-store/src";
import type { AnalyzePullRequestJob } from "../../../packages/shared-types/src";

/**
 * Runtime configuration for the worker process.
 */
interface WorkerConfig {
  /**
   * Poll interval in milliseconds for local queue file checks.
   */
  pollIntervalMs: number;
}

/**
 * Loads worker runtime configuration from environment variables.
 *
 * @returns Validated worker configuration.
 */
function loadConfig(): WorkerConfig {
  const pollRaw = process.env.WORKER_POLL_INTERVAL_MS ?? "3000";
  const pollIntervalMs = Number.parseInt(pollRaw, 10);

  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 250) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS value: ${pollRaw}`);
  }

  return { pollIntervalMs };
}

/**
 * Builds a stable idempotency key for queued analysis jobs.
 *
 * @param job Pull request analysis job payload.
 * @returns Stable idempotency key scoped to repository PR head SHA.
 */
function buildIdempotencyKey(job: AnalyzePullRequestJob): string {
  return `${job.repo_full_name}#${job.pr_number}@${job.head_sha}`;
}

/**
 * Processes a queued analysis job.
 *
 * This is a skeleton implementation that currently logs work intake.
 * Future steps will fetch PR diffs, run rulepacks, and post review output.
 *
 * @param job Job payload to process.
 */
function processAnalyzePullRequestJob(job: AnalyzePullRequestJob): void {
  const key = buildIdempotencyKey(job);
  console.log(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"}`,
  );
}

const config = loadConfig();
const processedKeys = new Set<string>();

console.log(
  `[worker] started (poll=${config.pollIntervalMs}ms, source=${DEFAULT_JOB_FILE_PATH})`,
);

setInterval(() => {
  const jobs = readAllAnalyzePullRequestJobs();

  for (const job of jobs) {
    const key = buildIdempotencyKey(job);
    if (processedKeys.has(key)) {
      continue;
    }

    processAnalyzePullRequestJob(job);
    processedKeys.add(key);
  }
}, config.pollIntervalMs);
