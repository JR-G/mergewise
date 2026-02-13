import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  enqueueAnalyzePullRequestJob,
  readAllAnalyzePullRequestJobs,
} from "@mergewise/job-store";
import type { GitHubPullRequestWebhookEvent } from "@mergewise/shared-types";
import {
  buildAnalyzePullRequestJob,
  computeGitHubSignature,
  isPullRequestWebhookEvent,
  isWebhookSignatureValid,
  SUPPORTED_PULL_REQUEST_ACTIONS,
} from "@mergewise/webhook-api";
import { buildIdempotencyKey } from "@mergewise/worker";

import validOpened from "./fixtures/valid-pr-opened.json";
import validSynchronize from "./fixtures/valid-pr-synchronize.json";
import invalidMissingPr from "./fixtures/invalid-missing-pr.json";
import invalidWrongAction from "./fixtures/invalid-wrong-action.json";

function makeTempDir(): string {
  const dir = join(tmpdir(), `mergewise-integration-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("webhook-to-worker pipeline", () => {
  let tempDir: string;
  let queuePath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    queuePath = join(tempDir, "jobs.ndjson");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("valid payload flows through validate → build → enqueue → read → idempotency key", () => {
    expect(isPullRequestWebhookEvent(validOpened)).toBe(true);

    const job = buildAnalyzePullRequestJob(
      validOpened as GitHubPullRequestWebhookEvent,
    );
    expect(job.repo_full_name).toBe("acme/widget");
    expect(job.pr_number).toBe(1);

    enqueueAnalyzePullRequestJob(job, queuePath);

    const jobs = readAllAnalyzePullRequestJobs(queuePath);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_id).toBe(job.job_id);

    const key = buildIdempotencyKey(jobs[0]!);
    expect(key).toContain("acme/widget");
    expect(key).toContain("#1@");
  });

  test("multiple payloads produce multiple jobs", () => {
    const payloads = [validOpened, validSynchronize];

    for (const payload of payloads) {
      expect(isPullRequestWebhookEvent(payload)).toBe(true);
      const job = buildAnalyzePullRequestJob(
        payload as GitHubPullRequestWebhookEvent,
      );
      enqueueAnalyzePullRequestJob(job, queuePath);
    }

    const jobs = readAllAnalyzePullRequestJobs(queuePath);
    expect(jobs).toHaveLength(2);

    const keys = jobs.map((job) => buildIdempotencyKey(job));
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("invalid payload is rejected before reaching the queue", () => {
    expect(isPullRequestWebhookEvent(invalidMissingPr)).toBe(false);

    const jobs = readAllAnalyzePullRequestJobs(queuePath);
    expect(jobs).toHaveLength(0);
  });

  test("unsupported action is filtered by supported actions set", () => {
    expect(isPullRequestWebhookEvent(invalidWrongAction)).toBe(true);

    const actions = SUPPORTED_PULL_REQUEST_ACTIONS as ReadonlySet<string>;
    expect(actions.has(invalidWrongAction.action)).toBe(false);
  });

  test("signature verification gates enqueue", () => {
    const payload = JSON.stringify(validOpened);
    const secret = "integration-test-secret";
    const validSig = computeGitHubSignature(payload, secret);

    expect(isWebhookSignatureValid(payload, validSig, secret)).toBe(true);
    expect(isWebhookSignatureValid(payload, "sha256=tampered", secret)).toBe(false);
  });
});
