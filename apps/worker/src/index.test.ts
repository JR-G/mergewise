import { afterEach, describe, expect, test } from "bun:test";

import {
  buildAnalysisContext,
  buildJobSummary,
  buildIdempotencyKey,
  createProcessedKeyState,
  loadAnalysisContextForJob,
  loadConfig,
  processAnalyzePullRequestJob,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
} from "./index";

describe("buildIdempotencyKey", () => {
  test("produces repo#pr@sha format", () => {
    const key = buildIdempotencyKey({
      job_id: "j1",
      installation_id: 1,
      repo_full_name: "acme/widget",
      pr_number: 42,
      head_sha: "abc123",
      queued_at: "2025-01-01T00:00:00Z",
    });
    expect(key).toBe("acme/widget#42@abc123");
  });

  test("different SHA produces different key", () => {
    const base = {
      job_id: "j1",
      installation_id: 1,
      repo_full_name: "acme/widget",
      pr_number: 42,
      queued_at: "2025-01-01T00:00:00Z",
    };

    const keyA = buildIdempotencyKey({ ...base, head_sha: "aaa" });
    const keyB = buildIdempotencyKey({ ...base, head_sha: "bbb" });
    expect(keyA).not.toBe(keyB);
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

describe("buildAnalysisContext", () => {
  test("maps queued job fields to rule-engine analysis context", () => {
    const diffs = [
      {
        filePath: "src/example.ts",
        previousPath: null,
        hunks: [{ header: "@@ -1,0 +1,1 @@", lines: ["+const value = 1;"] }],
      },
    ];
    const context = buildAnalysisContext({
      job_id: "j1",
      installation_id: 99,
      repo_full_name: "acme/widget",
      pr_number: 42,
      head_sha: "abc123",
      queued_at: "2025-01-01T00:00:00Z",
    }, diffs);

    expect(context.diffs).toEqual(diffs);
    expect(context.pullRequest.repo).toBe("acme/widget");
    expect(context.pullRequest.prNumber).toBe(42);
    expect(context.pullRequest.headSha).toBe("abc123");
    expect(context.pullRequest.installationId).toBe(99);
  });
});

describe("buildJobSummary", () => {
  test("returns deterministic summary fields from execution result", () => {
    const processedAt = "2026-02-13T12:00:00.000Z";
    const summary = buildJobSummary(
      {
        job_id: "job-1",
        installation_id: 99,
        repo_full_name: "acme/widget",
        pr_number: 42,
        head_sha: "abc123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      "acme/widget#42@abc123",
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
      processedAt,
    );

    expect(summary.jobId).toBe("job-1");
    expect(summary.idempotencyKey).toBe("acme/widget#42@abc123");
    expect(summary.repository).toBe("acme/widget");
    expect(summary.pullRequestNumber).toBe(42);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(1);
    expect(summary.successfulRules).toBe(1);
    expect(summary.failedRules).toBe(0);
    expect(summary.failedRuleIds).toEqual([]);
    expect(summary.processedAt).toBe(processedAt);
  });
});

describe("processAnalyzePullRequestJob", () => {
  test("executes rules and returns summary", async () => {
    const infoMessages: string[] = [];
    const errorMessages: string[] = [];

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-2",
        installation_id: 99,
        repo_full_name: "acme/widget",
        pr_number: 50,
        head_sha: "def456",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        loadAnalysisContextFn: async () => ({
          diffs: [],
          pullRequest: {
            repo: "acme/widget",
            prNumber: 50,
            headSha: "def456",
            installationId: 99,
          },
        }),
        executeRulesFn: async () => ({
          findings: [],
          summary: {
            totalRules: 2,
            successfulRules: 1,
            failedRules: 1,
            totalFindings: 0,
            findingsByCategory: {
              clean: 0,
              perf: 0,
              safety: 0,
              idiomatic: 0,
            },
          },
          failedRuleIds: ["sample/failing-rule"],
        }),
        logInfo: (message) => {
          infoMessages.push(message);
        },
        logError: (message) => {
          errorMessages.push(message);
        },
      },
    );

    expect(summary).not.toBeNull();
    if (!summary) {
      throw new Error("Expected worker summary");
    }
    expect(summary.jobId).toBe("job-2");
    expect(summary.idempotencyKey).toBe("acme/widget#50@def456");
    expect(summary.totalRules).toBe(2);
    expect(summary.successfulRules).toBe(1);
    expect(summary.failedRules).toBe(1);
    expect(summary.failedRuleIds).toEqual(["sample/failing-rule"]);
    expect(infoMessages).toHaveLength(2);
    expect(errorMessages).toEqual([]);
  });

  test("returns null and logs when executeRules throws unexpectedly", async () => {
    const errorMessages: string[] = [];

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-3",
        installation_id: 99,
        repo_full_name: "acme/widget",
        pr_number: 51,
        head_sha: "aaa111",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        loadAnalysisContextFn: async () => ({
          diffs: [],
          pullRequest: {
            repo: "acme/widget",
            prNumber: 51,
            headSha: "aaa111",
            installationId: 99,
          },
        }),
        executeRulesFn: async () => {
          throw new Error("unexpected execute failure");
        },
        logInfo: () => {},
        logError: (message) => {
          errorMessages.push(message);
        },
      },
    );

    expect(summary).toBeNull();
    expect(errorMessages).toHaveLength(1);
    expect(errorMessages[0]).toContain("failed to execute rules job=job-3");
  });
});

describe("loadAnalysisContextForJob", () => {
  test("loads pull request files and maps patches to analysis diffs", async () => {
    const context = await loadAnalysisContextForJob(
      {
        job_id: "job-4",
        installation_id: 10,
        repo_full_name: "acme/widget",
        pr_number: 8,
        head_sha: "abc999",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        env: {
          GITHUB_APP_ID: "123",
          GITHUB_APP_PRIVATE_KEY_PEM: "pem-value",
        },
        createGitHubAppJwtFn: () => "jwt-token",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesFn: async () => [
          {
            filename: "src/example.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,0 +1,1 @@\n+const value: any = input;",
          },
        ],
      },
    );

    expect(context.pullRequest.repo).toBe("acme/widget");
    expect(context.pullRequest.prNumber).toBe(8);
    expect(context.diffs).toHaveLength(1);
    expect(context.diffs[0]!.filePath).toBe("src/example.ts");
    expect(context.diffs[0]!.hunks).toHaveLength(1);
    expect(context.diffs[0]!.hunks[0]!.header).toBe("@@ -1,0 +1,1 @@");
    expect(context.diffs[0]!.hunks[0]!.lines).toEqual([
      "+const value: any = input;",
    ]);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.WORKER_POLL_INTERVAL_MS = originalEnv.WORKER_POLL_INTERVAL_MS;
    process.env.WORKER_MAX_PROCESSED_KEYS = originalEnv.WORKER_MAX_PROCESSED_KEYS;
  });

  test("returns defaults when env is unset", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    delete process.env.WORKER_MAX_PROCESSED_KEYS;
    const cfg = loadConfig();
    expect(cfg.pollIntervalMs).toBe(3000);
    expect(cfg.maxProcessedKeys).toBe(10000);
  });

  test("throws for below-minimum poll interval", () => {
    process.env.WORKER_POLL_INTERVAL_MS = "100";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });

  test("throws for below-minimum max keys", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    process.env.WORKER_MAX_PROCESSED_KEYS = "50";
    expect(() => loadConfig()).toThrow("Invalid WORKER_MAX_PROCESSED_KEYS value");
  });

  test("throws for non-numeric values", () => {
    process.env.WORKER_POLL_INTERVAL_MS = "abc";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });
});
