import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";

import type { AnalyzePullRequestJob, CollectFeedbackJob, QueueJob } from "@mergewise/shared-types";

/**
 * Logical queue file location used by the local development skeleton.
 *
 * The production implementation will be replaced with Redis/SQS-backed
 * queueing, but this keeps v1 scaffolding runnable with zero infra.
 */
export const DEFAULT_JOB_FILE_PATH = ".mergewise-runtime/jobs.ndjson";

/**
 * Result of reading the queue file from a byte offset.
 */
export interface QueueReadResult {
  readonly jobs: QueueJob[];
  readonly byteOffset: number;
}

/**
 * Derives the offset persistence file path from a queue file path.
 *
 * @param queueFilePath - Path to the NDJSON queue file.
 * @returns Sibling path with `.offset` extension.
 */
export function deriveOffsetFilePath(queueFilePath: string): string {
  return queueFilePath.replace(/\.ndjson$/, ".offset");
}

/**
 * Reads the persisted byte offset from the offset file.
 *
 * @remarks
 * Returns 0 when the file is missing, empty, or contains an invalid value.
 *
 * @param offsetFilePath - Path to the offset file.
 * @returns Non-negative integer byte offset.
 */
export function readQueueOffset(offsetFilePath: string): number {
  if (!existsSync(offsetFilePath)) {
    return 0;
  }

  const raw = readFileSync(offsetFilePath, "utf8").trim();
  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

/**
 * Atomically persists the byte offset to the offset file.
 *
 * @remarks
 * Writes to a temporary sibling file then renames to avoid partial writes on crash.
 *
 * @param offsetFilePath - Path to the offset file.
 * @param offset - Non-negative byte offset to persist.
 */
export function writeQueueOffset(offsetFilePath: string, offset: number): void {
  ensureParentDirectory(offsetFilePath);
  const tmpPath = `${offsetFilePath}.tmp`;
  writeFileSync(tmpPath, String(offset), "utf8");
  renameSync(tmpPath, offsetFilePath);
}

/**
 * Callback invoked when a queue line is skipped during reading.
 *
 * @param lineNumber - One-indexed line number in the queue file.
 * @param reason - Human-readable reason the line was skipped.
 */
export type OnSkippedLine = (lineNumber: number, reason: string) => void;

/**
 * Default skip handler that logs to stderr.
 */
function defaultOnSkippedLine(lineNumber: number, reason: string): void {
  console.error(`[job-store] skipping queue line=${lineNumber}: ${reason}`);
}

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

  const rawType = (value as Record<string, unknown>).type;
  if (rawType !== undefined && rawType !== "analyze-pull-request") {
    return false;
  }

  const candidate = value as Partial<AnalyzePullRequestJob>;
  if (
    typeof candidate.job_id !== "string" ||
    typeof candidate.repo_full_name !== "string" ||
    typeof candidate.head_sha !== "string" ||
    typeof candidate.queued_at !== "string"
  ) {
    return false;
  }
  if (candidate.trace_id !== undefined && typeof candidate.trace_id !== "string") {
    return false;
  }
  if (
    candidate.installation_id !== null &&
    (typeof candidate.installation_id !== "number" || !Number.isInteger(candidate.installation_id) || candidate.installation_id <= 0)
  ) {
    return false;
  }
  if (typeof candidate.pr_number !== "number" || !Number.isInteger(candidate.pr_number) || candidate.pr_number <= 0) {
    return false;
  }
  return true;
}

/**
 * Appends a job as one NDJSON line to the local queue file.
 *
 * @remarks
 * This local file-backed queue is intended for development only. It does not
 * provide multi-writer safety guarantees and should be replaced with a queue
 * backend such as Redis or SQS for concurrent production workloads.
 *
 * @param job - Analysis job payload to persist.
 * @param filePath - Optional file path override for tests/local customization.
 * @throws May throw on file system errors (permissions, disk full, etc.).
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
 * @remarks
 * Malformed JSON lines and shape-mismatched payloads are skipped via the
 * `onSkippedLine` callback so one bad entry does not prevent the rest of the
 * queue from being read.
 * Empty lines are ignored without callback noise.
 *
 * @param filePath - Optional file path override for tests/local customization.
 * @param onSkippedLine - Optional callback for skipped lines. Defaults to stderr logging.
 * @returns Parsed analysis jobs in file order.
 */
export function readAllAnalyzePullRequestJobs(
  filePath = DEFAULT_JOB_FILE_PATH,
  onSkippedLine: OnSkippedLine = defaultOnSkippedLine,
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
    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isAnalyzePullRequestJob(parsed)) {
        onSkippedLine(index + 1, "shape mismatch");
        continue;
      }

      jobs.push(parsed);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      onSkippedLine(index + 1, details);
    }
  }

  return jobs;
}

/**
 * Determines whether a parsed value matches the collect-feedback job shape.
 *
 * @param value - Parsed JSON value from the local queue file.
 * @returns `true` when the value satisfies required collect-feedback job fields.
 */
export function isCollectFeedbackJob(value: unknown): value is CollectFeedbackJob {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CollectFeedbackJob>;
  if (
    candidate.type !== "collect-feedback" ||
    typeof candidate.job_id !== "string" ||
    typeof candidate.repo_full_name !== "string" ||
    typeof candidate.queued_at !== "string"
  ) {
    return false;
  }
  if (candidate.installation_id !== null && typeof candidate.installation_id !== "number") {
    return false;
  }
  if (typeof candidate.installation_id === "number" && (!Number.isFinite(candidate.installation_id) || !Number.isInteger(candidate.installation_id) || candidate.installation_id <= 0)) {
    return false;
  }
  if (candidate.trace_id !== undefined && typeof candidate.trace_id !== "string") {
    return false;
  }
  if (typeof candidate.pr_number !== "number" || !Number.isFinite(candidate.pr_number) || !Number.isInteger(candidate.pr_number) || candidate.pr_number <= 0) {
    return false;
  }
  return true;
}

/**
 * Appends a collect-feedback job as one NDJSON line to the local queue file.
 *
 * @param job - Collect-feedback job payload to persist.
 * @param filePath - Optional file path override for tests/local customization.
 * @throws May throw on file system errors (permissions, disk full, etc.).
 */
export function enqueueCollectFeedbackJob(
  job: CollectFeedbackJob,
  filePath = DEFAULT_JOB_FILE_PATH,
): void {
  ensureParentDirectory(filePath);
  appendFileSync(filePath, `${JSON.stringify(job)}\n`, "utf8");
}

/**
 * Maximum number of jobs read from the queue file in a single call.
 */
const MAX_QUEUE_SIZE = 10_000;

/**
 * Maximum number of input lines scanned per poll, including malformed lines.
 */
const MAX_SCAN_LINES = 50_000;

/**
 * Reads queued jobs from the local NDJSON queue file using line-by-line streaming.
 *
 * @remarks
 * Lines without a `type` field are treated as `AnalyzePullRequestJob` for
 * backward compatibility with queue entries written before the discriminator
 * was introduced. Reading stops once `MAX_QUEUE_SIZE` jobs have been collected.
 *
 * When `startByteOffset` is provided, reading begins at that byte position.
 * If the offset exceeds the file size (file was truncated), reading resets to 0.
 *
 * @param filePath - Optional file path override for tests/local customization.
 * @param onSkippedLine - Optional callback for skipped lines. Defaults to stderr logging.
 * @param startByteOffset - Byte position to resume reading from. Defaults to 0.
 * @returns Parsed queue jobs and the new byte offset after reading.
 */
export async function readAllQueueJobs(
  filePath = DEFAULT_JOB_FILE_PATH,
  onSkippedLine: OnSkippedLine = defaultOnSkippedLine,
  startByteOffset = 0,
): Promise<QueueReadResult> {
  if (!existsSync(filePath)) {
    return { jobs: [], byteOffset: 0 };
  }

  const fileSize = statSync(filePath).size;
  const safeOffset = (startByteOffset > 0 && startByteOffset <= fileSize) ? startByteOffset : 0;

  if (safeOffset >= fileSize) {
    return { jobs: [], byteOffset: safeOffset };
  }

  const jobs: QueueJob[] = [];
  const streamOptions = safeOffset > 0
    ? { encoding: "utf8" as const, start: safeOffset }
    : { encoding: "utf8" as const };
  const stream = createReadStream(filePath, streamOptions);
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let bytesConsumed = 0;

  try {
    for await (const line of reader) {
      lineNumber++;
      bytesConsumed += Buffer.byteLength(line, "utf8") + 1;

      if (!line.trim()) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as unknown;
        if (isCollectFeedbackJob(parsed)) {
          jobs.push(parsed);
        } else if (isAnalyzePullRequestJob(parsed)) {
          jobs.push(parsed);
        } else {
          onSkippedLine(lineNumber, "shape mismatch");
        }
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        onSkippedLine(lineNumber, details);
      }

      if (jobs.length >= MAX_QUEUE_SIZE || lineNumber >= MAX_SCAN_LINES) {
        break;
      }
    }
  } finally {
    reader.close();
  }

  return { jobs, byteOffset: Math.min(safeOffset + bytesConsumed, fileSize) };
}
