import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnalyzePullRequestJob, CollectFeedbackJob } from "@mergewise/shared-types";

import {
  deriveOffsetFilePath,
  enqueueAnalyzePullRequestJob,
  enqueueCollectFeedbackJob,
  isCollectFeedbackJob,
  readAllAnalyzePullRequestJobs,
  readAllQueueJobs,
  readQueueOffset,
  writeQueueOffset,
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

interface Skip {
  lineNumber: number;
  reason: string;
}

function collectSkips(): { callback: OnSkippedLine; skips: Skip[] } {
  const skips: Skip[] = [];
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
    expect((JSON.parse(lines[0]!) as { job_id: string }).job_id).toBe("aaa");
    expect((JSON.parse(lines[1]!) as { job_id: string }).job_id).toBe("bbb");
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

function makeFeedbackJob(overrides: Partial<CollectFeedbackJob> = {}): CollectFeedbackJob {
  return {
    type: "collect-feedback",
    job_id: randomUUID(),
    installation_id: 42,
    repo_full_name: "acme/widget",
    pr_number: 7,
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
    expect(isCollectFeedbackJob(makeJob())).toBe(false);
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
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: -1 as number }))).toBe(false);
  });

  test("returns false for pr_number zero", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: 0 }))).toBe(false);
  });

  test("returns false for NaN pr_number", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: Number.NaN }))).toBe(false);
  });

  test("returns false for non-integer float pr_number", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: 1.5 as number }))).toBe(false);
  });

  test("returns true for MAX_SAFE_INTEGER pr_number", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: Number.MAX_SAFE_INTEGER }))).toBe(true);
  });

  test("returns false for zero installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: 0 as number }))).toBe(false);
  });

  test("returns false for zero pr_number", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ pr_number: 0 as number }))).toBe(false);
  });

  test("returns false for negative installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: -1 as number }))).toBe(false);
  });

  test("returns false for NaN installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: Number.NaN }))).toBe(false);
  });

  test("returns false for Infinity installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  test("returns false for non-integer installation_id", () => {
    expect(isCollectFeedbackJob(makeFeedbackJob({ installation_id: 1.5 as number }))).toBe(false);
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

  test("round-trips enqueue then read via readAllQueueJobs", async () => {
    const feedbackJob = makeFeedbackJob();
    enqueueCollectFeedbackJob(feedbackJob, filePath);

    const result = await readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(feedbackJob);
  });
});

describe("readAllQueueJobs", () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    filePath = join(tempDir, "nested", "jobs.ndjson");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty result when file is missing", async () => {
    const missing = join(tempDir, "does-not-exist.ndjson");
    const result = await readAllQueueJobs(missing);
    expect(result.jobs).toEqual([]);
    expect(result.byteOffset).toBe(0);
  });

  test("reads mixed analyze and feedback jobs", async () => {
    const analyzeJob = makeJob({ job_id: "analyze-1" });
    const feedbackJob = makeFeedbackJob({ job_id: "feedback-1" });

    enqueueAnalyzePullRequestJob(analyzeJob, filePath);
    enqueueCollectFeedbackJob(feedbackJob, filePath);

    const result = await readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0]!.job_id).toBe("analyze-1");
    expect(result.jobs[1]!.job_id).toBe("feedback-1");
  });

  test("treats legacy lines without type field as analyze jobs", async () => {
    const legacyJob = {
      job_id: "legacy-1",
      installation_id: 42,
      repo_full_name: "acme/widget",
      pr_number: 7,
      head_sha: "abc123",
      queued_at: new Date().toISOString(),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(legacyJob)}\n`, "utf8");

    const result = await readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe("legacy-1");
  });

  test("skips malformed lines", async () => {
    const feedbackJob = makeFeedbackJob({ job_id: "good" });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `not-json\n${JSON.stringify(feedbackJob)}\n`, "utf8");

    const { callback, skips } = collectSkips();
    const result = await readAllQueueJobs(filePath, callback);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe("good");
    expect(skips).toHaveLength(1);
  });

  test("enforces MAX_QUEUE_SIZE cap on returned jobs", async () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const lines: string[] = [];
    for (let jobIndex = 0; jobIndex < 10_001; jobIndex++) {
      lines.push(JSON.stringify(makeFeedbackJob({ job_id: `job-${jobIndex}` })));
    }
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readAllQueueJobs(filePath);

    expect(result.jobs.length).toBe(10_000);
    const fileSize = readFileSync(filePath).byteLength;
    expect(result.byteOffset).toBeLessThan(fileSize);
  });

  test("returns byte offset matching file size after reading all jobs", async () => {
    const analyzeJob = makeJob({ job_id: "offset-test" });
    enqueueAnalyzePullRequestJob(analyzeJob, filePath);

    const result = await readAllQueueJobs(filePath);
    const fileSize = readFileSync(filePath).byteLength;

    expect(result.byteOffset).toBe(fileSize);
    expect(result.jobs).toHaveLength(1);
  });

  test("reads only new jobs when starting from a byte offset", async () => {
    const firstJob = makeJob({ job_id: "first" });
    enqueueAnalyzePullRequestJob(firstJob, filePath);

    const firstResult = await readAllQueueJobs(filePath);
    expect(firstResult.jobs).toHaveLength(1);

    const secondJob = makeJob({ job_id: "second" });
    enqueueAnalyzePullRequestJob(secondJob, filePath);

    const secondResult = await readAllQueueJobs(filePath, undefined, firstResult.byteOffset);
    expect(secondResult.jobs).toHaveLength(1);
    expect(secondResult.jobs[0]!.job_id).toBe("second");
  });

  test("returns empty jobs when offset equals file size", async () => {
    enqueueAnalyzePullRequestJob(makeJob(), filePath);
    const firstResult = await readAllQueueJobs(filePath);

    const secondResult = await readAllQueueJobs(filePath, undefined, firstResult.byteOffset);
    expect(secondResult.jobs).toEqual([]);
    expect(secondResult.byteOffset).toBe(firstResult.byteOffset);
  });

  test("resets to start when offset exceeds file size", async () => {
    enqueueAnalyzePullRequestJob(makeJob({ job_id: "reset-test" }), filePath);

    const result = await readAllQueueJobs(filePath, undefined, 999_999);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe("reset-test");
    expect(result.byteOffset).toBeGreaterThan(0);
  });

  test("throws on negative startByteOffset", async () => {
    enqueueAnalyzePullRequestJob(makeJob({ job_id: "neg-offset" }), filePath);
    expect(readAllQueueJobs(filePath, undefined, -10)).rejects.toThrow(RangeError);
  });

  test("throws on NaN startByteOffset", () => {
    expect(readAllQueueJobs(filePath, undefined, NaN)).rejects.toThrow(RangeError);
  });

  test("throws on fractional startByteOffset", () => {
    expect(readAllQueueJobs(filePath, undefined, 1.5)).rejects.toThrow(RangeError);
  });

  test("returns zero offset when file does not exist", async () => {
    const result = await readAllQueueJobs(join(tempDir, "missing.ndjson"), undefined, 42);
    expect(result.byteOffset).toBe(0);
    expect(result.jobs).toEqual([]);
  });
});

describe("deriveOffsetFilePath", () => {
  test("replaces .ndjson extension with .offset", () => {
    expect(deriveOffsetFilePath(".mergewise-runtime/jobs.ndjson")).toBe(
      ".mergewise-runtime/jobs.offset",
    );
  });

  test("leaves non-ndjson paths unchanged", () => {
    expect(deriveOffsetFilePath("queue.jsonl")).toBe("queue.jsonl");
  });
});

describe("readQueueOffset", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns 0 when file does not exist", () => {
    expect(readQueueOffset(join(tempDir, "missing.offset"))).toBe(0);
  });

  test("returns 0 when file is empty", () => {
    const offsetPath = join(tempDir, "empty.offset");
    writeFileSync(offsetPath, "", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("reads a valid integer offset", () => {
    const offsetPath = join(tempDir, "valid.offset");
    writeFileSync(offsetPath, "1234", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(1234);
  });

  test("returns 0 for negative values", () => {
    const offsetPath = join(tempDir, "neg.offset");
    writeFileSync(offsetPath, "-5", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("returns 0 for non-numeric content", () => {
    const offsetPath = join(tempDir, "garbage.offset");
    writeFileSync(offsetPath, "not-a-number", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("returns 0 for NaN", () => {
    const offsetPath = join(tempDir, "nan.offset");
    writeFileSync(offsetPath, "NaN", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("returns 0 for Infinity", () => {
    const offsetPath = join(tempDir, "inf.offset");
    writeFileSync(offsetPath, "Infinity", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("returns 0 for non-integer float", () => {
    const offsetPath = join(tempDir, "float.offset");
    writeFileSync(offsetPath, "1.5", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("reads zero offset correctly", () => {
    const offsetPath = join(tempDir, "zero.offset");
    writeFileSync(offsetPath, "0", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("trims whitespace around the value", () => {
    const offsetPath = join(tempDir, "padded.offset");
    writeFileSync(offsetPath, "  42  \n", "utf8");
    expect(readQueueOffset(offsetPath)).toBe(42);
  });
});

describe("writeQueueOffset", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes an offset that can be read back", () => {
    const offsetPath = join(tempDir, "roundtrip.offset");
    writeQueueOffset(offsetPath, 5678);
    expect(readQueueOffset(offsetPath)).toBe(5678);
  });

  test("creates parent directories when missing", () => {
    const offsetPath = join(tempDir, "deep", "nested", "test.offset");
    writeQueueOffset(offsetPath, 100);
    expect(existsSync(offsetPath)).toBe(true);
    expect(readQueueOffset(offsetPath)).toBe(100);
  });

  test("overwrites previous offset value", () => {
    const offsetPath = join(tempDir, "overwrite.offset");
    writeQueueOffset(offsetPath, 100);
    writeQueueOffset(offsetPath, 200);
    expect(readQueueOffset(offsetPath)).toBe(200);
  });

  test("writes zero offset", () => {
    const offsetPath = join(tempDir, "zero.offset");
    writeQueueOffset(offsetPath, 0);
    expect(readQueueOffset(offsetPath)).toBe(0);
  });

  test("writes large offset values", () => {
    const offsetPath = join(tempDir, "large.offset");
    const largeOffset = 2_147_483_647;
    writeQueueOffset(offsetPath, largeOffset);
    expect(readQueueOffset(offsetPath)).toBe(largeOffset);
  });

  test("rejects NaN offset", () => {
    const offsetPath = join(tempDir, "nan.offset");
    expect(() => writeQueueOffset(offsetPath, NaN)).toThrow(RangeError);
  });

  test("rejects negative offset", () => {
    const offsetPath = join(tempDir, "neg.offset");
    expect(() => writeQueueOffset(offsetPath, -1)).toThrow(RangeError);
  });

  test("rejects non-integer offset", () => {
    const offsetPath = join(tempDir, "float.offset");
    expect(() => writeQueueOffset(offsetPath, 1.5)).toThrow(RangeError);
  });

  test("rejects Infinity offset", () => {
    const offsetPath = join(tempDir, "inf.offset");
    expect(() => writeQueueOffset(offsetPath, Infinity)).toThrow(RangeError);
  });
});
