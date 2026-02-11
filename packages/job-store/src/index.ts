import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AnalyzePullRequestJob } from "../../shared-types/src";

/**
 * Logical queue file location used by the local development skeleton.
 *
 * The production implementation will be replaced with Redis/SQS-backed
 * queueing, but this keeps v1 scaffolding runnable with zero infra.
 */
export const DEFAULT_JOB_FILE_PATH = ".mergewise-runtime/jobs.ndjson";

/**
 * Ensures the parent directory for a file path exists.
 *
 * @param filePath Path to the target file.
 */
function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Appends a job as one NDJSON line to the local queue file.
 *
 * @param job Analysis job payload to persist.
 * @param filePath Optional file path override for tests/local customization.
 */
export function enqueueAnalyzePullRequestJob(
  job: AnalyzePullRequestJob,
  filePath = DEFAULT_JOB_FILE_PATH,
): void {
  ensureParentDirectory(filePath);
  appendFileSync(filePath, `${JSON.stringify(job)}\n`, "utf8");
}

/**
 * Reads all currently queued jobs from the local NDJSON queue file.
 *
 * @param filePath Optional file path override for tests/local customization.
 * @returns Parsed analysis jobs in file order.
 */
export function readAllAnalyzePullRequestJobs(
  filePath = DEFAULT_JOB_FILE_PATH,
): AnalyzePullRequestJob[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as AnalyzePullRequestJob);
}
