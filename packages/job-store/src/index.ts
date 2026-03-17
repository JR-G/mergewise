import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AnalyzePullRequestJob, CollectFeedbackJob, IndexRepoJob, QueueJob } from "@mergewise/shared-types";
import {
  tryParseInstallationId,
  tryParseJobId,
  tryParsePRNumber,
  tryParseRepoFullName,
  tryParseSHA,
} from "@mergewise/shared-types";

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
  let raw: string;
  try {
    raw = readFileSync(offsetFilePath, "utf8").trim();
  } catch {
    return 0;
  }

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
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`writeQueueOffset: expected a finite non-negative integer, got ${offset}`);
  }
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

  const rawType = (value as Record<string, unknown>)["type"];
  if (rawType !== undefined && rawType !== "analyze-pull-request") {
    return false;
  }

  const candidate = value as Partial<Record<string, unknown>>;
  if (typeof candidate["job_id"] !== "string" || !tryParseJobId(candidate["job_id"])) return false;
  if (typeof candidate["repo_full_name"] !== "string" || !tryParseRepoFullName(candidate["repo_full_name"])) return false;
  if (typeof candidate["head_sha"] !== "string" || !tryParseSHA(candidate["head_sha"])) return false;
  if (typeof candidate["queued_at"] !== "string") return false;
  if (candidate["trace_id"] !== undefined && typeof candidate["trace_id"] !== "string") return false;
  if (candidate["installation_id"] !== null && (typeof candidate["installation_id"] !== "number" || !tryParseInstallationId(candidate["installation_id"]))) return false;
  if (typeof candidate["pr_number"] !== "number" || !tryParsePRNumber(candidate["pr_number"])) return false;
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

  const candidate = value as Partial<Record<string, unknown>>;
  if (candidate["type"] !== "collect-feedback") return false;
  if (typeof candidate["job_id"] !== "string" || !tryParseJobId(candidate["job_id"])) return false;
  if (typeof candidate["repo_full_name"] !== "string" || !tryParseRepoFullName(candidate["repo_full_name"])) return false;
  if (typeof candidate["queued_at"] !== "string") return false;
  if (candidate["installation_id"] !== null && (typeof candidate["installation_id"] !== "number" || !tryParseInstallationId(candidate["installation_id"]))) return false;
  if (candidate["trace_id"] !== undefined && typeof candidate["trace_id"] !== "string") return false;
  if (typeof candidate["pr_number"] !== "number" || !tryParsePRNumber(candidate["pr_number"])) return false;
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
 * Determines whether a parsed value matches the index-repo job shape.
 *
 * @param value - Parsed JSON value from the local queue file.
 * @returns `true` when the value satisfies required index-repo job fields.
 */
export function isIndexRepoJob(value: unknown): value is IndexRepoJob {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Record<string, unknown>>;
  if (candidate["type"] !== "index-repo") return false;
  if (typeof candidate["job_id"] !== "string" || !tryParseJobId(candidate["job_id"])) return false;
  if (typeof candidate["repo_full_name"] !== "string" || !tryParseRepoFullName(candidate["repo_full_name"])) return false;
  if (typeof candidate["default_branch"] !== "string") return false;
  if (typeof candidate["head_sha"] !== "string" || !tryParseSHA(candidate["head_sha"])) return false;
  if (typeof candidate["queued_at"] !== "string") return false;
  if (candidate["trace_id"] !== undefined && typeof candidate["trace_id"] !== "string") return false;
  if (candidate["installation_id"] !== null && (typeof candidate["installation_id"] !== "number" || !tryParseInstallationId(candidate["installation_id"]))) return false;
  return true;
}

/**
 * Appends an index-repo job as one NDJSON line to the local queue file.
 *
 * @param job - Index-repo job payload to persist.
 * @param filePath - Optional file path override for tests/local customization.
 * @throws May throw on file system errors (permissions, disk full, etc.).
 */
export function enqueueIndexRepoJob(
  job: IndexRepoJob,
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
 * Byte length of the line separator written by enqueue functions.
 *
 * @remarks
 * All enqueue paths use explicit `"\n"` (Unix LF). The `readline` interface
 * with `crlfDelay: Infinity` strips the full terminator, so this constant
 * must match the separator actually written. If enqueue ever switches to
 * CRLF, this must change to 2.
 */
const LINE_SEPARATOR_BYTES = 1;

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
export function readAllQueueJobs(
  filePath = DEFAULT_JOB_FILE_PATH,
  onSkippedLine: OnSkippedLine = defaultOnSkippedLine,
  startByteOffset = 0,
): QueueReadResult {
  if (startByteOffset !== 0 && (!Number.isFinite(startByteOffset) || !Number.isInteger(startByteOffset) || startByteOffset < 0)) {
    throw new RangeError(`readAllQueueJobs: startByteOffset must be a finite non-negative integer, got ${startByteOffset}`);
  }

  if (!existsSync(filePath)) {
    return { jobs: [], byteOffset: 0 };
  }

  const fileSize = statSync(filePath).size;
  const safeOffset = (startByteOffset > 0 && startByteOffset <= fileSize) ? startByteOffset : 0;

  if (safeOffset >= fileSize) {
    return { jobs: [], byteOffset: safeOffset };
  }

  const bytesToRead = fileSize - safeOffset;
  const slice = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, slice, 0, bytesToRead, safeOffset);
  } finally {
    closeSync(fd);
  }
  const content = slice.toString("utf8");
  const lines = content.split("\n");

  const jobs: QueueJob[] = [];
  let lineNumber = 0;
  let bytesConsumed = 0;

  for (const line of lines) {
    if (bytesConsumed + Buffer.byteLength(line, "utf8") > slice.byteLength) {
      break;
    }

    const isLastElement = lineNumber === lines.length - 1;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const separatorBytes = isLastElement && !content.endsWith("\n") ? 0 : LINE_SEPARATOR_BYTES;
    bytesConsumed += lineBytes + separatorBytes;
    lineNumber++;

    if (!line.trim()) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (isCollectFeedbackJob(parsed) || isIndexRepoJob(parsed) || isAnalyzePullRequestJob(parsed)) {
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

  return { jobs, byteOffset: Math.min(safeOffset + bytesConsumed, fileSize) };
}
