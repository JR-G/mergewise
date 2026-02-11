import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

import {
  enqueueAnalyzePullRequestJob,
  readAllAnalyzePullRequestJobs,
} from "./index";
import type { OnSkippedLine } from "./index";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mergewise-job-store-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeJob(overrides: Partial<AnalyzePullRequestJob> = {}): AnalyzePullRequestJob {
  return {
    job_id: randomUUID(),
    installation_id: 42,
    repo_full_name: "acme/widget",
    pr_number: 7,
    head_sha: "abc123",
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

function collectSkips(): { callback: OnSkippedLine; skips: Array<{ lineNumber: number; reason: string }> } {
  const skips: Array<{ lineNumber: number; reason: string }> = [];
  const callback: OnSkippedLine = (lineNumber, reason) => {
    skips.push({ lineNumber, reason });
  };
  return { callback, skips };
}

describe("job-store", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    filePath = join(tempDir, "nested", "jobs.ndjson");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates parent directory and file when they do not exist", () => {
    const job = makeJob();
    enqueueAnalyzePullRequestJob(job, filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  test("appends as NDJSON with trailing newline", () => {
    const jobA = makeJob({ job_id: "aaa" });
    const jobB = makeJob({ job_id: "bbb" });

    enqueueAnalyzePullRequestJob(jobA, filePath);
    enqueueAnalyzePullRequestJob(jobB, filePath);

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!).job_id).toBe("aaa");
    expect(JSON.parse(lines[1]!).job_id).toBe("bbb");
  });

  test("returns empty array when file is missing", () => {
    const missing = join(tempDir, "does-not-exist.ndjson");
    expect(readAllAnalyzePullRequestJobs(missing)).toEqual([]);
  });

  test("returns empty array when file is empty", () => {
    const emptyPath = join(tempDir, "empty.ndjson");
    writeFileSync(emptyPath, "", "utf8");
    expect(readAllAnalyzePullRequestJobs(emptyPath)).toEqual([]);
  });

  test("skips malformed JSON without throwing", () => {
    enqueueAnalyzePullRequestJob(makeJob(), filePath);
    writeFileSync(filePath, "not-json\n", "utf8");

    const { callback, skips } = collectSkips();
    const result = readAllAnalyzePullRequestJobs(filePath, callback);

    expect(result).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.lineNumber).toBe(1);
  });

  test("skips valid JSON with wrong shape", () => {
    enqueueAnalyzePullRequestJob(makeJob(), filePath);
    writeFileSync(filePath, `${JSON.stringify({ random: "object" })}\n`, "utf8");

    const { callback, skips } = collectSkips();
    const result = readAllAnalyzePullRequestJobs(filePath, callback);

    expect(result).toEqual([]);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.reason).toBe("shape mismatch");
  });

  test("returns valid jobs when malformed and invalid lines are mixed in", () => {
    const firstJob = makeJob({ job_id: "first" });
    const secondJob = makeJob({ job_id: "second" });
    const mixedRaw = [
      JSON.stringify(firstJob),
      "not-json",
      JSON.stringify({ random: "object" }),
      "   ",
      JSON.stringify(secondJob),
      "",
    ].join("\n");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, mixedRaw, "utf8");

    const { callback, skips } = collectSkips();
    const jobs = readAllAnalyzePullRequestJobs(filePath, callback);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.job_id).toBe("first");
    expect(jobs[1]!.job_id).toBe("second");
    expect(skips).toHaveLength(2);
    expect(skips[0]!.lineNumber).toBe(2);
    expect(skips[1]!.lineNumber).toBe(3);
  });

  test("round-trips enqueue then read", () => {
    const job = makeJob();
    enqueueAnalyzePullRequestJob(job, filePath);

    const jobs = readAllAnalyzePullRequestJobs(filePath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(job);
  });
});
