import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiError } from "@mergewise/github-client";
import {
  generateJobId,
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
  toSHA,
} from "@mergewise/shared-types";

import {
  buildAnalysisContext,
  buildFindingDedupeKey,
  buildIdempotencyKey,
  buildJobSummary,
  createPollingLoopController,
  createProcessedKeyState,
  fetchPullRequestFilesWithRetry,
  loadConfig,
  parseRepositoryFullName,
  resolveJobTraceId,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
  wrapCodeIdentifiers,
  type WorkerPollingTimerHandle,
} from "./index";

const SHA_ABC = toSHA("abc123".padEnd(40, "0"));
const SHA_AAA = toSHA("a".repeat(40));
const SHA_BBB = toSHA("b".repeat(40));

describe("buildIdempotencyKey", () => {
  test("produces repo#pr@sha format", () => {
    const key = buildIdempotencyKey({
      job_id: generateJobId(),
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      queued_at: "2025-01-01T00:00:00Z",
    });
    expect(key).toBe(`acme/widget#42@${SHA_ABC}`);
  });

  test("different SHA produces different key", () => {
    const base = {
      job_id: generateJobId(),
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      queued_at: "2025-01-01T00:00:00Z",
    };

    const keyA = buildIdempotencyKey({ ...base, head_sha: SHA_AAA });
    const keyB = buildIdempotencyKey({ ...base, head_sha: SHA_BBB });
    expect(keyA).not.toBe(keyB);
  });
});

describe("resolveJobTraceId", () => {
  test("uses explicit job trace_id when provided", () => {
    const jobId = generateJobId();
    const traceId = resolveJobTraceId({
      job_id: jobId,
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      trace_id: "trace-123",
      queued_at: "2025-01-01T00:00:00Z",
    });

    expect(traceId).toBe("trace-123");
  });

  test("falls back to job_id when trace_id is missing", () => {
    const jobId = generateJobId();
    const traceId = resolveJobTraceId({
      job_id: jobId,
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      queued_at: "2025-01-01T00:00:00Z",
    });

    expect(traceId).toBe(jobId);
  });
});

describe("buildFindingDedupeKey", () => {
  test("builds stable key from findingId", () => {
    const finding = {
      findingId: "r1:file:1",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(1),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
  });

  test("builds fallback key from ruleId:filePath:line when findingId is empty", () => {
    const finding = {
      findingId: "",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(10),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:test/rule-1:src/index.ts:10");
  });

  test("builds fallback key when findingId is whitespace-only", () => {
    const finding = {
      findingId: "   ",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(10),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:test/rule-1:src/index.ts:10");
  });
});

describe("trackProcessedKey", () => {
  test("adds key to state", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("key-1", state, 10);
    expect(state.keys.has("key-1")).toBe(true);
    expect(state.order).toEqual(["key-1"]);
  });

  test("evicts oldest key at max capacity via FIFO", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("a", state, 2);
    trackProcessedKey("b", state, 2);
    trackProcessedKey("c", state, 2);

    expect(state.keys.has("a")).toBe(false);
    expect(state.keys.has("b")).toBe(true);
    expect(state.keys.has("c")).toBe(true);
    expect(state.order).toEqual(["b", "c"]);
  });

  test("preserves insertion order", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("x", state, 5);
    trackProcessedKey("y", state, 5);
    trackProcessedKey("z", state, 5);
    expect(state.order).toEqual(["x", "y", "z"]);
  });

  test("ignores duplicate keys and keeps order/key set consistent", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("a", state, 2);
    trackProcessedKey("a", state, 2);
    trackProcessedKey("b", state, 2);
    trackProcessedKey("c", state, 2);

    expect(state.order).toEqual(["b", "c"]);
    expect(state.keys.has("a")).toBe(false);
    expect(state.keys.has("b")).toBe(true);
    expect(state.keys.has("c")).toBe(true);
  });
});

describe("runPollCycleWithInFlightGuard", () => {
  test("runs when no poll is in flight and resets state", async () => {
    const state = { isPollInFlight: false };
    let runCount = 0;

    const wasRun = await runPollCycleWithInFlightGuard(state, async () => {
      runCount += 1;
    });

    expect(wasRun).toBe(true);
    expect(runCount).toBe(1);
    expect(state.isPollInFlight).toBe(false);
  });

  test("skips overlapping run when a poll is already in flight", async () => {
    let releasePollCycle: () => void = () => {};
    const firstPollStarted = new Promise<void>((resolve) => {
      releasePollCycle = resolve;
    });
    const state = { isPollInFlight: false };
    let runCount = 0;

    const firstRunPromise = runPollCycleWithInFlightGuard(state, async () => {
      runCount += 1;
      await firstPollStarted;
    });

    const secondRunResult = await runPollCycleWithInFlightGuard(state, async () => {
      runCount += 1;
    });

    expect(secondRunResult).toBe(false);
    expect(runCount).toBe(1);
    expect(state.isPollInFlight).toBe(true);

    releasePollCycle();
    const firstRunResult = await firstRunPromise;

    expect(firstRunResult).toBe(true);
    expect(state.isPollInFlight).toBe(false);
  });
});

describe("createPollingLoopController", () => {
  test("starts interval once and clears it on stop", async () => {
    const scheduledCallbacks: (() => void)[] = [];
    const clearedTimers: WorkerPollingTimerHandle[] = [];
    const timerHandle = {} as WorkerPollingTimerHandle;
    let runCount = 0;

    const controller = createPollingLoopController(
      250,
      async () => {
        runCount += 1;
      },
      {
        setIntervalFn: (callback) => {
          scheduledCallbacks.push(callback);
          return timerHandle;
        },
        clearIntervalFn: (receivedTimerHandle) => {
          clearedTimers.push(receivedTimerHandle);
        },
      },
    );

    controller.start();
    controller.start();
    expect(controller.isRunning()).toBe(true);
    expect(scheduledCallbacks).toHaveLength(1);

    const [scheduledCallback] = scheduledCallbacks;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- callback may be async at runtime
    await scheduledCallback?.();
    expect(runCount).toBe(1);

    await controller.stop();
    expect(controller.isRunning()).toBe(false);
    expect(clearedTimers).toEqual([timerHandle]);
  });

  test("stop waits for in-flight poll cycle completion", async () => {
    const scheduledCallbacks: (() => void)[] = [];
    let releasePollCycle: () => void = () => {};
    const pollCycleStarted = new Promise<void>((resolve) => {
      releasePollCycle = resolve;
    });
    const timerHandle = {} as WorkerPollingTimerHandle;

    const controller = createPollingLoopController(
      250,
      async () => {
        await pollCycleStarted;
      },
      {
        setIntervalFn: (callback) => {
          scheduledCallbacks.push(callback);
          return timerHandle;
        },
        clearIntervalFn: () => {},
      },
    );

    controller.start();
    const [scheduledCallback] = scheduledCallbacks;
    const runningPollCycle = scheduledCallback?.();
    let didStopResolve = false;
    const stopPromise = controller.stop().then(() => {
      didStopResolve = true;
    });
    await Promise.resolve();
    expect(didStopResolve).toBe(false);

    releasePollCycle();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- callback may be async at runtime
    await runningPollCycle;
    await stopPromise;
    expect(didStopResolve).toBe(true);
  });
});

describe("parseRepositoryFullName", () => {
  test("returns owner and repository for valid value", () => {
    expect(parseRepositoryFullName("acme/widget")).toEqual({
      owner: "acme",
      repository: "widget",
    });
  });

  test("returns null for invalid values", () => {
    expect(parseRepositoryFullName("acme")).toBeNull();
    expect(parseRepositoryFullName("acme/widget/extra")).toBeNull();
    expect(parseRepositoryFullName("/")).toBeNull();
  });
});

describe("fetchPullRequestFilesWithRetry", () => {
  test("retries transient GitHubApiError then succeeds", async () => {
    let callCount = 0;
    const sleepDurations: number[] = [];

    const files = await fetchPullRequestFilesWithRetry(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 8,
        installationAccessToken: "token",
      },
      2,
      5,
      {
        fetchPullRequestFiles: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new GitHubApiError(503, "GET", "https://api.github.com/x", "down");
          }

          return [
            {
              filename: "src/index.ts",
              status: "modified",
              additions: 1,
              deletions: 0,
              changes: 1,
            },
          ];
        },
        sleep: async (delayMs) => {
          sleepDurations.push(delayMs);
        },
      },
    );

    expect(callCount).toBe(2);
    expect(sleepDurations).toEqual([5]);
    expect(files).toHaveLength(1);
  });

  test("does not retry non-retryable GitHubApiError", async () => {
    let callCount = 0;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is thenable at runtime
    await expect(
      fetchPullRequestFilesWithRetry(
        {
          owner: "acme",
          repository: "widget",
          pullRequestNumber: 8,
          installationAccessToken: "token",
        },
        2,
        5,
        {
          fetchPullRequestFiles: async () => {
            callCount += 1;
            throw new GitHubApiError(404, "GET", "https://api.github.com/x", "missing");
          },
          sleep: async () => {},
        },
      ),
    ).rejects.toBeInstanceOf(GitHubApiError);

    expect(callCount).toBe(1);
  });
});

describe("buildAnalysisContext", () => {
  test("maps queued job fields and provided diffs to analysis context", () => {
    const context = buildAnalysisContext(
      {
        job_id: generateJobId(),
        installation_id: toInstallationId(99),
        repo_full_name: toRepoFullName("acme/widget"),
        pr_number: toPRNumber(42),
        head_sha: SHA_ABC,
        queued_at: "2025-01-01T00:00:00Z",
      },
      [
        {
          filePath: toFilePath("src/index.ts"),
          previousPath: null,
          hunks: [
            {
              header: "@@ -1,1 +1,2 @@",
              lines: ["-const a = 1;", "+const value = 1;", "+const b = 2;"],
            },
          ],
        },
      ],
    );

    expect(context.diffs).toHaveLength(1);
    expect(context.diffs[0]?.filePath).toBe(toFilePath("src/index.ts"));
    expect(context.pullRequest.repo).toBe(toRepoFullName("acme/widget"));
    expect(context.pullRequest.prNumber).toBe(toPRNumber(42));
    expect(context.pullRequest.headSha).toBe(SHA_ABC);
    expect(context.pullRequest.installationId).toBe(toInstallationId(99));
  });
});

describe("buildJobSummary", () => {
  test("returns deterministic summary fields from execution result", () => {
    const jobId = generateJobId();
    const summary = buildJobSummary(
      {
        job_id: jobId,
        installation_id: toInstallationId(99),
        repo_full_name: toRepoFullName("acme/widget"),
        pr_number: toPRNumber(42),
        head_sha: SHA_ABC,
        queued_at: "2025-01-01T00:00:00Z",
      },
      `acme/widget#42@${SHA_ABC}`,
      {
        findings: [],
        summary: {
          totalRules: 1,
          successfulRules: 1,
          failedRules: 0,
          totalFindings: 0,
          findingsByCategory: {
            clean: 0,
            perf: 0,
            safety: 0,
            idiomatic: 0,
          },
        },
        failedRuleIds: [],
      },
      "2026-01-02T03:04:05.000Z",
    );

    expect(summary.jobId).toBe(jobId);
    expect(summary.idempotencyKey).toBe(`acme/widget#42@${SHA_ABC}`);
    expect(summary.repository).toBe("acme/widget");
    expect(summary.pullRequestNumber).toBe(42);
    expect(summary.traceId).toBe(jobId);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(1);
    expect(summary.successfulRules).toBe(1);
    expect(summary.failedRules).toBe(0);
    expect(summary.failedRuleIds).toEqual([]);
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("wrapCodeIdentifiers", () => {
  test("wraps camelCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Refactor processUserRequest to adhere to SRP")).toBe(
      "Refactor `processUserRequest` to adhere to SRP",
    );
  });

  test("wraps PascalCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Extract UserService into a separate module")).toBe(
      "Extract `UserService` into a separate module",
    );
  });

  test("wraps dotted member access in backticks", () => {
    expect(wrapCodeIdentifiers("Call this.handleRequest instead")).toBe(
      "Call `this.handleRequest` instead",
    );
  });

  test("preserves identifiers already in backticks", () => {
    expect(wrapCodeIdentifiers("Use `processUserRequest` here")).toBe(
      "Use `processUserRequest` here",
    );
  });

  test("leaves plain words unchanged", () => {
    expect(wrapCodeIdentifiers("Extract the logic into separate functions")).toBe(
      "Extract the logic into separate functions",
    );
  });

  test("leaves acronyms and uppercase words unchanged", () => {
    expect(wrapCodeIdentifiers("Follow SRP and DRY principles")).toBe(
      "Follow SRP and DRY principles",
    );
  });

  test("wraps single-quoted camelCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Use the 'suggestedRewrite' field")).toBe(
      "Use the `suggestedRewrite` field",
    );
  });

  test("leaves single-quoted plain words unchanged", () => {
    expect(wrapCodeIdentifiers("This is a 'simple' example")).toBe(
      "This is a 'simple' example",
    );
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns defaults when env is unset", () => {
    delete process.env["WORKER_POLL_INTERVAL_MS"];
    delete process.env["WORKER_MAX_PROCESSED_KEYS"];
    delete process.env["GITHUB_API_BASE_URL"];
    delete process.env["WORKER_GITHUB_USER_AGENT"];
    delete process.env["WORKER_GITHUB_REQUEST_TIMEOUT_MS"];
    delete process.env["WORKER_GITHUB_FETCH_RETRIES"];
    delete process.env["WORKER_GITHUB_RETRY_DELAY_MS"];
    delete process.env["WORKER_FINDING_CONFIDENCE_THRESHOLD"];
    delete process.env["WORKER_FINDING_MAX_COMMENTS"];
    delete process.env["WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD"];

    const config = loadConfig();

    expect(config.pollIntervalMs).toBe(3000);
    expect(config.maxProcessedKeys).toBe(10000);
    expect(config.githubApiBaseUrl).toBe("https://api.github.com");
    expect(config.githubUserAgent).toBe("mergewise-worker");
    expect(config.githubRequestTimeoutMs).toBe(10000);
    expect(config.githubFetchRetries).toBe(2);
    expect(config.githubRetryDelayMs).toBe(250);
    expect(config.confidenceThreshold).toBe(0.78);
    expect(config.maxComments).toBe(5);
    expect(config.testFileConfidenceThreshold).toBe(0.98);
  });

  test("throws for below-minimum poll interval", () => {
    process.env["WORKER_POLL_INTERVAL_MS"] = "100";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });

  test("throws for below-minimum max keys", () => {
    delete process.env["WORKER_POLL_INTERVAL_MS"];
    process.env["WORKER_MAX_PROCESSED_KEYS"] = "50";
    expect(() => loadConfig()).toThrow("Invalid WORKER_MAX_PROCESSED_KEYS value");
  });

  test("throws for non-numeric poll interval", () => {
    process.env["WORKER_POLL_INTERVAL_MS"] = "abc";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });

  test("throws for negative fetch retries", () => {
    process.env["WORKER_GITHUB_FETCH_RETRIES"] = "-1";
    expect(() => loadConfig()).toThrow("Invalid WORKER_GITHUB_FETCH_RETRIES value");
  });

  test("throws for timeout below minimum", () => {
    process.env["WORKER_GITHUB_REQUEST_TIMEOUT_MS"] = "50";
    expect(() => loadConfig()).toThrow("Invalid WORKER_GITHUB_REQUEST_TIMEOUT_MS value");
  });

  test("throws for invalid confidence threshold", () => {
    process.env["WORKER_FINDING_CONFIDENCE_THRESHOLD"] = "2";
    expect(() => loadConfig()).toThrow("Invalid WORKER_FINDING_CONFIDENCE_THRESHOLD value");
  });

  test("throws for invalid max comments", () => {
    process.env["WORKER_FINDING_MAX_COMMENTS"] = "0";
    expect(() => loadConfig()).toThrow("Invalid WORKER_FINDING_MAX_COMMENTS value");
  });

  test("throws for invalid test file confidence threshold", () => {
    process.env["WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD"] = "1.2";
    expect(() => loadConfig()).toThrow(
      "Invalid WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD value",
    );
  });
});
