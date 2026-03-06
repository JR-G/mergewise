import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AnalyzePullRequestJob, CollectFeedbackJob } from "@mergewise/shared-types";

import {
  enqueueAnalyzePullRequestJob,
  enqueueCollectFeedbackJob,
  isCollectFeedbackJob,
  readAllAnalyzePullRequestJobs,
  readAllQueueJobs,
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

    const jobs = await readAllQueueJobs(filePath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual(feedbackJob);
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

  test("returns empty array when file is missing", async () => {
    const missing = join(tempDir, "does-not-exist.ndjson");
    expect(await readAllQueueJobs(missing)).toEqual([]);
  });

  test("reads mixed analyze and feedback jobs", async () => {
    const analyzeJob = makeJob({ job_id: "analyze-1" });
    const feedbackJob = makeFeedbackJob({ job_id: "feedback-1" });

    enqueueAnalyzePullRequestJob(analyzeJob, filePath);
    enqueueCollectFeedbackJob(feedbackJob, filePath);

    const jobs = await readAllQueueJobs(filePath);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.job_id).toBe("analyze-1");
    expect(jobs[1]!.job_id).toBe("feedback-1");
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

    const jobs = await readAllQueueJobs(filePath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_id).toBe("legacy-1");
  });

  test("skips malformed lines", async () => {
    const feedbackJob = makeFeedbackJob({ job_id: "good" });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `not-json\n${JSON.stringify(feedbackJob)}\n`, "utf8");

    const { callback, skips } = collectSkips();
    const jobs = await readAllQueueJobs(filePath, callback);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_id).toBe("good");
    expect(skips).toHaveLength(1);
  });

  test("enforces MAX_QUEUE_SIZE cap on returned jobs", async () => {
    mkdirSync(dirname(filePath), { recursive: true });
    const lines: string[] = [];
    for (let jobIndex = 0; jobIndex < 10_001; jobIndex++) {
      lines.push(JSON.stringify(makeFeedbackJob({ job_id: `job-${jobIndex}` })));
    }
    writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const jobs = await readAllQueueJobs(filePath);

    expect(jobs.length).toBeLessThanOrEqual(10_000);
  });
});
