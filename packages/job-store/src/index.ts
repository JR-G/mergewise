import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

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
 * @param filePath - Path to the target file.
 */
function ensureParentDirectory(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

/**
 * Determines whether a parsed value matches the expected job payload shape.
 *
 * @param value - Parsed JSON value from the local queue file.
 * @returns `true` when the value satisfies required job fields.
 */
function isAnalyzePullRequestJob(value: unknown): value is AnalyzePullRequestJob {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AnalyzePullRequestJob>;
  return (
    typeof candidate.job_id === "string" &&
    (typeof candidate.installation_id === "number" ||
      candidate.installation_id === null) &&
    typeof candidate.repo_full_name === "string" &&
    typeof candidate.pr_number === "number" &&
    typeof candidate.head_sha === "string" &&
    typeof candidate.queued_at === "string"
  );
}

/**
 * Appends a job as one NDJSON line to the local queue file.
 *
 * @param job - Analysis job payload to persist.
 * @param filePath - Optional file path override for tests/local customization.
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
 * @param filePath - Optional file path override for tests/local customization.
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

  const jobs: AnalyzePullRequestJob[] = [];
  const lines = raw.split("\n");

  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isAnalyzePullRequestJob(parsed)) {
        console.error(
          `[job-store] skipping invalid queue job line=${index + 1}: shape mismatch`,
        );
        continue;
      }

      jobs.push(parsed);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error(
        `[job-store] skipping malformed queue line=${index + 1}: ${details}`,
      );
    }
  }

  return jobs;
}
