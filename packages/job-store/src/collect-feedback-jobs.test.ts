import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CollectFeedbackJob } from "@mergewise/shared-types";
import {
  generateJobId,
  toInstallationId,
  toPRNumber,
  toRepoFullName,
} from "@mergewise/shared-types";

import {
  enqueueCollectFeedbackJob,
  isCollectFeedbackJob,
  readAllQueueJobs,
} from "./index";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mergewise-job-store-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAnalyzeJob(): { job_id: string; installation_id: number; repo_full_name: string; pr_number: number; head_sha: string; queued_at: string } {
  return {
    job_id: randomUUID(),
    installation_id: 42,
    repo_full_name: "acme/widget",
    pr_number: 7,
    head_sha: "abc123",
    queued_at: new Date().toISOString(),
  };
}

function makeFeedbackJob(overrides: Partial<CollectFeedbackJob> = {}): CollectFeedbackJob {
  return {
    type: "collect-feedback",
    job_id: generateJobId(),
    installation_id: toInstallationId(42),
    repo_full_name: toRepoFullName("acme/widget"),
    pr_number: toPRNumber(7),
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("isCollectFeedbackJob", () => {
  test("returns true for valid collect-feedback job", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob())).toBe(true);
  });

  test("returns false for null", () => {
    expect(isCollectFeedbackJob(null)).toBe(false);
  });

  test("returns false for analyze job (wrong type)", () => {
    expect(isCollectFeedbackJob(makeAnalyzeJob())).toBe(false);
  });

  test("returns false when required fields are missing", () => {
    expect(isCollectFeedbackJob({ type: "collect-feedback" })).toBe(false);
  });

  test("returns true with null installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: null }))).toBe(true);
  });

  test("returns true with optional trace_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ trace_id: "abc" }))).toBe(true);
  });

  test("returns false for negative pr_number", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), pr_number: -1 })).toBe(false);
  });

  test("returns false for pr_number zero", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), pr_number: 0 })).toBe(false);
  });

  test("returns false for NaN pr_number", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), pr_number: Number.NaN })).toBe(false);
  });

  test("returns false for non-integer float pr_number", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), pr_number: 1.5 })).toBe(false);
  });

  test("returns true for MAX_SAFE_INTEGER pr_number", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), pr_number: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  test("returns false for zero installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: 0 })).toBe(false);
  });

  test("returns false for negative installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: -1 })).toBe(false);
  });

  test("returns false for NaN installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: Number.NaN })).toBe(false);
  });

  test("returns false for Infinity installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test("returns false for non-integer installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: 1.5 })).toBe(false);
  });

  test("returns true for MAX_SAFE_INTEGER installation_id", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  test("returns false for installation_id exceeding MAX_SAFE_INTEGER", () => {
    expect(isCollectFeedbackJob({ ...makeFeedbackJob(), installation_id: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });
});

describe("enqueueCollectFeedbackJob", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    filePath = join(tempDir, "nested", "jobs.ndjson");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("round-trips enqueue then read via readAllQueueJobs", () => {
    const feedbackJob = makeFeedbackJob();
    enqueueCollectFeedbackJob(feedbackJob, filePath);

    const result = readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(feedbackJob);
  });
});
