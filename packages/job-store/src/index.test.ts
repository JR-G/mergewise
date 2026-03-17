import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnalyzePullRequestJob, CollectFeedbackJob, IndexRepoJob } from "@mergewise/shared-types";
import {
  generateJobId,
  toInstallationId,
  toJobId,
  toPRNumber,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";

import {
  deriveOffsetFilePath,
  enqueueAnalyzePullRequestJob,
  enqueueCollectFeedbackJob,
  enqueueIndexRepoJob,
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
    job_id: generateJobId(),
    installation_id: toInstallationId(42),
    repo_full_name: toRepoFullName("acme/widget"),
    pr_number: toPRNumber(7),
    head_sha: toSHA("a".repeat(40)),
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
    const jobIdA = toJobId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const jobIdB = toJobId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const jobA = makeJob({ job_id: jobIdA });
    const jobB = makeJob({ job_id: jobIdB });

    enqueueAnalyzePullRequestJob(jobA, filePath);
    enqueueAnalyzePullRequestJob(jobB, filePath);

    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");

    expect(lines[2]).toBe("");
    expect((JSON.parse(lines[0]!) as { job_id: string }).job_id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect((JSON.parse(lines[1]!) as { job_id: string }).job_id).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
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
    expect(skips.map((skip) => skip.lineNumber)).toEqual([1]);
  });

  test("skips valid JSON with wrong shape", () => {
    enqueueAnalyzePullRequestJob(makeJob(), filePath);
    writeFileSync(filePath, `${JSON.stringify({ random: "object" })}\n`, "utf8");

    const { callback, skips } = collectSkips();
    const result = readAllAnalyzePullRequestJobs(filePath, callback);

    expect(result).toEqual([]);
    expect(skips.map((skip) => skip.reason)).toEqual(["shape mismatch"]);
  });

  test("returns valid jobs when malformed and invalid lines are mixed in", () => {
    const firstId = toJobId("11111111-1111-1111-1111-111111111111");
    const secondId = toJobId("22222222-2222-2222-2222-222222222222");
    const firstJob = makeJob({ job_id: firstId });
    const secondJob = makeJob({ job_id: secondId });
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

    expect(jobs.map((job) => job.job_id)).toEqual([firstId, secondId]);
    expect(skips.map((skip) => skip.lineNumber)).toEqual([2, 3]);
  });

  test("round-trips enqueue then read", () => {
    const job = makeJob();
    enqueueAnalyzePullRequestJob(job, filePath);

    const jobs = readAllAnalyzePullRequestJobs(filePath);
    expect(jobs).toEqual([job]);
  });
});

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

  test("returns empty result when file is missing", () => {
    const missing = join(tempDir, "does-not-exist.ndjson");
    const result = readAllQueueJobs(missing);
    expect(result.jobs).toEqual([]);
    expect(result.byteOffset).toBe(0);
  });

  test("reads mixed analyze, feedback, and index-repo jobs", () => {
    const analyzeId = toJobId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const feedbackId = toJobId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const analyzeJob = makeJob({ job_id: analyzeId });
    const feedbackJob = makeFeedbackJob({ job_id: feedbackId });
    const indexId = toJobId("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const indexJob = makeIndexRepoJob({ job_id: indexId });

    enqueueAnalyzePullRequestJob(analyzeJob, filePath);
    enqueueCollectFeedbackJob(feedbackJob, filePath);
    enqueueIndexRepoJob(indexJob, filePath);

    const result = readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(3);
    expect(result.jobs[0]!.job_id).toBe(analyzeId);
    expect(result.jobs[1]!.job_id).toBe(feedbackId);
    expect(result.jobs[2]!.job_id).toBe(indexId);
  });

  test("treats legacy lines without type field as analyze jobs", () => {
    const legacyJobId = toJobId("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const legacyJob = {
      job_id: legacyJobId,
      installation_id: 42,
      repo_full_name: "acme/widget",
      pr_number: 7,
      head_sha: "a".repeat(40),
      queued_at: new Date().toISOString(),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(legacyJob)}\n`, "utf8");

    const result = readAllQueueJobs(filePath);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe(legacyJobId);
  });

  test("skips malformed lines", () => {
    const goodId = toJobId("dddddddd-dddd-dddd-dddd-dddddddddddd");
    const feedbackJob = makeFeedbackJob({ job_id: goodId });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `not-json\n${JSON.stringify(feedbackJob)}\n`, "utf8");

    const { callback, skips } = collectSkips();
    const result = readAllQueueJobs(filePath, callback);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe(goodId);
    expect(skips).toHaveLength(1);
  });

  test("enforces MAX_QUEUE_SIZE cap on returned jobs", () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const lines: string[] = [];
    for (let jobIndex = 0; jobIndex < 10_001; jobIndex++) {
      lines.push(JSON.stringify(makeFeedbackJob()));
    }
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = readAllQueueJobs(filePath);

    expect(result.jobs.length).toBe(10_000);
    const fileSize = readFileSync(filePath).byteLength;
    expect(result.byteOffset).toBeLessThan(fileSize);
  });

  test("returns byte offset matching file size after reading all jobs", () => {
    const analyzeJob = makeJob({ job_id: toJobId("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee") });
    enqueueAnalyzePullRequestJob(analyzeJob, filePath);

    const result = readAllQueueJobs(filePath);
    const fileSize = readFileSync(filePath).byteLength;

    expect(result.byteOffset).toBe(fileSize);
    expect(result.jobs).toHaveLength(1);
  });

  test("reads only new jobs when starting from a byte offset", () => {
    const firstJob = makeJob({ job_id: toJobId("ffffffff-ffff-ffff-ffff-ffffffffffff") });
    enqueueAnalyzePullRequestJob(firstJob, filePath);

    const firstResult = readAllQueueJobs(filePath);
    expect(firstResult.jobs).toHaveLength(1);

    const secondJob = makeJob({ job_id: toJobId("99999999-9999-9999-9999-999999999999") });
    enqueueAnalyzePullRequestJob(secondJob, filePath);

    const secondResult = readAllQueueJobs(filePath, undefined, firstResult.byteOffset);
    expect(secondResult.jobs).toHaveLength(1);
    expect(secondResult.jobs[0]!.job_id).toBe(toJobId("99999999-9999-9999-9999-999999999999"));
  });

  test("returns empty jobs when offset equals file size", () => {
    enqueueAnalyzePullRequestJob(makeJob(), filePath);
    const firstResult = readAllQueueJobs(filePath);

    const secondResult = readAllQueueJobs(filePath, undefined, firstResult.byteOffset);
    expect(secondResult.jobs).toEqual([]);
    expect(secondResult.byteOffset).toBe(firstResult.byteOffset);
  });

  test("resets to start when offset exceeds file size", () => {
    enqueueAnalyzePullRequestJob(makeJob({ job_id: toJobId("88888888-8888-8888-8888-888888888888") }), filePath);

    const result = readAllQueueJobs(filePath, undefined, 999_999);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.job_id).toBe(toJobId("88888888-8888-8888-8888-888888888888"));
    expect(result.byteOffset).toBeGreaterThan(0);
  });

  test("throws on negative startByteOffset", () => {
    enqueueAnalyzePullRequestJob(makeJob({ job_id: toJobId("77777777-7777-7777-7777-777777777777") }), filePath);
    expect(() => readAllQueueJobs(filePath, undefined, -10)).toThrow(RangeError);
  });

  test("throws on NaN startByteOffset", () => {
    expect(() => readAllQueueJobs(filePath, undefined, NaN)).toThrow(RangeError);
  });

  test("throws on fractional startByteOffset", () => {
    expect(() => readAllQueueJobs(filePath, undefined, 1.5)).toThrow(RangeError);
  });

  test("returns zero offset when file does not exist", () => {
    const result = readAllQueueJobs(join(tempDir, "missing.ndjson"), undefined, 42);
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
