import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiError } from "@mergewise/github-client";

import {
  buildAnalysisContext,
  buildJobSummary,
  buildIdempotencyKey,
  createProcessedKeyState,
  fetchPullRequestFilesWithRetry,
  loadConfig,
  parseRepositoryFullName,
  processAnalyzePullRequestJob,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
  type WorkerGitHubFetchOptions,
} from "./index";

const workerFetchOptions: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-worker-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 2,
  githubRetryDelayMs: 1,
};

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
        job_id: "j1",
        installation_id: 99,
        repo_full_name: "acme/widget",
        pr_number: 42,
        head_sha: "abc123",
        queued_at: "2025-01-01T00:00:00Z",
      },
      [
        {
          filePath: "src/index.ts",
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
    expect(context.diffs[0]?.filePath).toBe("src/index.ts");
    expect(context.pullRequest.repo).toBe("acme/widget");
    expect(context.pullRequest.prNumber).toBe(42);
    expect(context.pullRequest.headSha).toBe("abc123");
    expect(context.pullRequest.installationId).toBe(99);
  });
});

describe("buildJobSummary", () => {
  test("returns deterministic summary fields from execution result", () => {
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
      "2026-01-02T03:04:05.000Z",
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
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("processAnalyzePullRequestJob", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("successful fetch feeds rule execution and returns deterministic summary", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";

    const capturedContexts: unknown[] = [];

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-2",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 50,
        head_sha: "def456",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules: [],
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@ -1,1 +1,2 @@\n-const a = 1;\n+const value = 1;\n+const b = 2;",
          },
        ],
        executeRulesFn: async ({ context }) => {
          capturedContexts.push(context);
          return {
            findings: [],
            summary: {
              totalRules: 0,
              successfulRules: 0,
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
          };
        },
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      },
    );

    const analysisContext = capturedContexts[0] as {
      diffs: Array<{ filePath: string; hunks: Array<{ header: string; lines: string[] }> }>;
    };

    expect(analysisContext.diffs).toHaveLength(1);
    expect(analysisContext.diffs[0]?.filePath).toBe("src/index.ts");
    expect(analysisContext.diffs[0]?.hunks[0]?.header).toBe("@@ -1,1 +1,2 @@");
    expect(analysisContext.diffs[0]?.hunks[0]?.lines).toEqual([
      "-const a = 1;",
      "+const value = 1;",
      "+const b = 2;",
    ]);
    expect(summary.jobId).toBe("job-2");
    expect(summary.idempotencyKey).toBe("acme/widget#50@def456");
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("non-retryable GitHub fetch failure is surfaced", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----";

    await expect(
      processAnalyzePullRequestJob(
        {
          job_id: "job-3",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 51,
          head_sha: "def457",
          queued_at: "2025-01-01T00:00:00Z",
        },
        {
          githubFetchOptions: workerFetchOptions,
          createGitHubAppJwtFn: () => "jwt",
          exchangeInstallationAccessTokenFn: async () => ({
            token: "installation-token",
            expires_at: "2026-01-01T00:00:00Z",
          }),
          fetchPullRequestFilesWithRetryFn: async () => {
            throw new GitHubApiError(404, "GET", "https://api.github.com/x", "missing");
          },
        },
      ),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("returns defaults when env is unset", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    delete process.env.WORKER_MAX_PROCESSED_KEYS;
    delete process.env.GITHUB_API_BASE_URL;
    delete process.env.WORKER_GITHUB_USER_AGENT;
    delete process.env.WORKER_GITHUB_REQUEST_TIMEOUT_MS;
    delete process.env.WORKER_GITHUB_FETCH_RETRIES;
    delete process.env.WORKER_GITHUB_RETRY_DELAY_MS;

    const config = loadConfig();

    expect(config.pollIntervalMs).toBe(3000);
    expect(config.maxProcessedKeys).toBe(10000);
    expect(config.githubApiBaseUrl).toBe("https://api.github.com");
    expect(config.githubUserAgent).toBe("mergewise-worker");
    expect(config.githubRequestTimeoutMs).toBe(10000);
    expect(config.githubFetchRetries).toBe(2);
    expect(config.githubRetryDelayMs).toBe(250);
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

  test("throws for non-numeric poll interval", () => {
    process.env.WORKER_POLL_INTERVAL_MS = "abc";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });

  test("throws for negative fetch retries", () => {
    process.env.WORKER_GITHUB_FETCH_RETRIES = "-1";
    expect(() => loadConfig()).toThrow("Invalid WORKER_GITHUB_FETCH_RETRIES value");
  });

  test("throws for timeout below minimum", () => {
    process.env.WORKER_GITHUB_REQUEST_TIMEOUT_MS = "50";
    expect(() => loadConfig()).toThrow("Invalid WORKER_GITHUB_REQUEST_TIMEOUT_MS value");
  });
});
