import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IndexRepoJob } from "@mergewise/shared-types";
import {
  generateJobId,
  toInstallationId,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";

import {
  enqueueIndexRepoJob,
  isIndexRepoJob,
  readAllQueueJobs,
} from "./index";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mergewise-job-store-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeIndexRepoJob(overrides: Partial<IndexRepoJob> = {}): IndexRepoJob {
  return {
    type: "index-repo",
    job_id: generateJobId(),
    installation_id: toInstallationId(42),
    repo_full_name: toRepoFullName("acme/widget"),
    default_branch: "main",
    head_sha: toSHA("a".repeat(40)),
    queued_at: new Date().toISOString(),
    ...overrides,
  };
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

describe("isIndexRepoJob", () => {
  test("returns true for valid index-repo job", () => {
    expect(isIndexRepoJob(makeIndexRepoJob())).toBe(true);
  });

  test("returns false for null", () => {
    expect(isIndexRepoJob(null)).toBe(false);
  });

  test("returns false when type field is missing", () => {
    const { type: _removed, ...withoutType } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutType)).toBe(false);
  });

  test("returns false for wrong type value", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), type: "collect-feedback" })).toBe(false);
  });

  test("returns false for analyze job (no type field)", () => {
    expect(isIndexRepoJob(makeAnalyzeJob())).toBe(false);
  });

  test("returns false when job_id is missing", () => {
    const { job_id: _removed, ...withoutJobId } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutJobId)).toBe(false);
  });

  test("returns false when repo_full_name is missing", () => {
    const { repo_full_name: _removed, ...withoutRepo } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutRepo)).toBe(false);
  });

  test("returns false when default_branch is missing", () => {
    const { default_branch: _removed, ...withoutBranch } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutBranch)).toBe(false);
  });

  test("returns false when head_sha is missing", () => {
    const { head_sha: _removed, ...withoutSha } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutSha)).toBe(false);
  });

  test("returns false when queued_at is missing", () => {
    const { queued_at: _removed, ...withoutQueuedAt } = makeIndexRepoJob();
    expect(isIndexRepoJob(withoutQueuedAt)).toBe(false);
  });

  test("returns true with null installation_id", () => {
    expect(isIndexRepoJob(makeIndexRepoJob({ installation_id: null }))).toBe(true);
  });

  test("returns true with optional trace_id", () => {
    expect(isIndexRepoJob(makeIndexRepoJob({ trace_id: "abc" }))).toBe(true);
  });

  test("returns false for zero installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: 0 })).toBe(false);
  });

  test("returns false for negative installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: -1 })).toBe(false);
  });

  test("returns false for NaN installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: Number.NaN })).toBe(false);
  });

  test("returns false for Infinity installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test("returns false for non-integer installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: 1.5 })).toBe(false);
  });

  test("returns true for MAX_SAFE_INTEGER installation_id", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  test("returns false for installation_id exceeding MAX_SAFE_INTEGER", () => {
    expect(isIndexRepoJob({ ...makeIndexRepoJob(), installation_id: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });
});

describe("enqueueIndexRepoJob", () => {
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
    const indexJob = makeIndexRepoJob();
    enqueueIndexRepoJob(indexJob, filePath);

    const result = readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(indexJob);
  });
});
