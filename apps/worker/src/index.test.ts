import { afterEach, describe, expect, test } from "bun:test";

import { GitHubApiError } from "@mergewise/github-client";
import type { Finding, FindingCategory, Rule } from "@mergewise/shared-types";

import {
  applyFindingGates,
  buildAnalysisContext,
  buildFindingDedupeKey,
  buildJobSummary,
  buildWorkerCheckOutput,
  buildIdempotencyKey,
  createProcessedKeyState,
  createPollingLoopController,
  fetchPullRequestFilesWithRetry,
  loadConfig,
  parseRepositoryFullName,
  postPreparedFindingComments,
  prepareFindingDelivery,
  processAnalyzePullRequestJob,
  runPollCycleWithInFlightGuard,
  trackProcessedKey,
  type WorkerPollingTimerHandle,
  type WorkerGitHubFetchOptions,
} from "./index";

const workerFetchOptions: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-worker-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 2,
  githubRetryDelayMs: 1,
};

function createRule(ruleId: string): Rule {
  return {
    kind: "stateless",
    metadata: {
      ruleId,
      name: ruleId,
      category: "clean",
      languages: ["typescript"],
      description: `${ruleId} description`,
    },
    analyse: async () => [],
  };
}

function createFinding(
  findingId: string,
  confidence: number,
  category: FindingCategory,
): Finding {
  return {
    findingId,
    installationId: 44,
    repo: "acme/widget",
    prNumber: 50,
    language: "typescript",
    ruleId: "rule-a",
    category,
    filePath: "src/index.ts",
    line: 1,
    evidence: "const unsafe: any = value",
    recommendation: "Avoid explicit any",
    confidence,
    status: "posted",
  };
}

function createExecutionResultWithFindings(findings: readonly Finding[]) {
  const findingsByCategory = {
    clean: 0,
    perf: 0,
    safety: 0,
    idiomatic: 0,
  };

  for (const finding of findings) {
    findingsByCategory[finding.category] += 1;
  }

  return {
    findings,
    summary: {
      totalRules: 0,
      successfulRules: 0,
      failedRules: 0,
      totalFindings: findings.length,
      findingsByCategory,
    },
    failedRuleIds: [],
  };
}

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

describe("buildFindingDedupeKey", () => {
  test("builds stable key from findingId", () => {
    const finding = {
      findingId: "r1:file:1",
      installationId: 1,
      repo: "acme/widget",
      prNumber: 42,
      language: "typescript",
      ruleId: "rule-1",
      category: "safety" as const,
      filePath: "src/index.ts",
      line: 1,
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: 0.95,
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
  });

  test("builds fallback key from ruleId:filePath:line when findingId is empty", () => {
    const finding = {
      findingId: "",
      installationId: 1,
      repo: "acme/widget",
      prNumber: 42,
      language: "typescript",
      ruleId: "rule-1",
      category: "safety" as const,
      filePath: "src/index.ts",
      line: 10,
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: 0.95,
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:rule-1:src/index.ts:10");
  });

  test("builds fallback key when findingId is whitespace-only", () => {
    const finding = {
      findingId: "   ",
      installationId: 1,
      repo: "acme/widget",
      prNumber: 42,
      language: "typescript",
      ruleId: "rule-1",
      category: "safety" as const,
      filePath: "src/index.ts",
      line: 10,
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: 0.95,
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:rule-1:src/index.ts:10");
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
    const scheduledCallbacks: Array<() => void> = [];
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
    await scheduledCallback?.();
    expect(runCount).toBe(1);

    await controller.stop();
    expect(controller.isRunning()).toBe(false);
    expect(clearedTimers).toEqual([timerHandle]);
  });

  test("stop waits for in-flight poll cycle completion", async () => {
    const scheduledCallbacks: Array<() => void> = [];
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
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

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
    expect(summary.postedCommentCount).toBe(0);
    expect(summary.skippedByCap).toBe(0);
    expect(summary.skippedByDeduplication).toBe(0);
    expect(summary.skippedByConfidence).toBe(0);
    expect(summary.checkOutput?.title).toContain("Mergewise Findings");
  });

  test("non-retryable GitHub fetch failure is surfaced", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

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

  test("supports legacy GITHUB_APP_PRIVATE_KEY_PEM when new key name is unset", async () => {
    process.env.GITHUB_APP_ID = "123";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY_PEM = "legacy-private-key";

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-legacy-key",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 52,
        head_sha: "def458",
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
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
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
        }),
      },
    );

    expect(summary.jobId).toBe("job-legacy-key");
  });

  test("invalid GITHUB_APP_ID surfaces explicit error", async () => {
    process.env.GITHUB_APP_ID = "not-a-number";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    await expect(
      processAnalyzePullRequestJob(
        {
          job_id: "job-invalid-app-id",
          installation_id: 44,
          repo_full_name: "acme/widget",
          pr_number: 53,
          head_sha: "def459",
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
          fetchPullRequestFilesWithRetryFn: async () => [],
          executeRulesFn: async () => ({
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
          }),
        },
      ),
    ).rejects.toThrow("[worker] invalid GITHUB_APP_ID value: not-a-number");
  });

  test("applies config-driven rule include/exclude selection", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const capturedRuleIds: string[][] = [];
    const rules = [createRule("rule-a"), createRule("rule-b"), createRule("rule-c")];

    await processAnalyzePullRequestJob(
      {
        job_id: "job-rule-selection",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 54,
        head_sha: "def460",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        rules,
        mergewiseConfig: {
          gating: {
            confidenceThreshold: 0,
            maxComments: 20,
          },
          rules: {
            include: ["rule-a", "rule-c"],
            exclude: ["rule-c"],
          },
        },
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async ({ rules: selectedRules }) => {
          capturedRuleIds.push(selectedRules.map((rule) => rule.metadata.ruleId));
          return {
            findings: [],
            summary: {
              totalRules: selectedRules.length,
              successfulRules: selectedRules.length,
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
      },
    );

    expect(capturedRuleIds).toEqual([["rule-a"]]);
  });

  test("applies confidence gating to execution summary and delivery cap separately", async () => {
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = "placeholder-private-key";

    const summary = await processAnalyzePullRequestJob(
      {
        job_id: "job-gating",
        installation_id: 44,
        repo_full_name: "acme/widget",
        pr_number: 55,
        head_sha: "def461",
        queued_at: "2025-01-01T00:00:00Z",
      },
      {
        githubFetchOptions: workerFetchOptions,
        mergewiseConfig: {
          gating: {
            confidenceThreshold: 0.8,
            maxComments: 2,
          },
          rules: {
            include: [],
            exclude: [],
          },
        },
        rules: [],
        createGitHubAppJwtFn: () => "jwt",
        exchangeInstallationAccessTokenFn: async () => ({
          token: "installation-token",
          expires_at: "2026-01-01T00:00:00Z",
        }),
        fetchPullRequestFilesWithRetryFn: async () => [],
        executeRulesFn: async () => ({
          findings: [
            createFinding("finding-low", 0.79, "clean"),
            createFinding("finding-high-1", 0.95, "perf"),
            createFinding("finding-high-2", 0.8, "safety"),
            createFinding("finding-high-3", 0.99, "idiomatic"),
          ],
          summary: {
            totalRules: 0,
            successfulRules: 0,
            failedRules: 0,
            totalFindings: 4,
            findingsByCategory: {
              clean: 1,
              perf: 1,
              safety: 1,
              idiomatic: 1,
            },
          },
          failedRuleIds: [],
        }),
      },
    );

    expect(summary.totalFindings).toBe(3);
    expect(summary.findingsByCategory).toEqual({
      clean: 0,
      perf: 1,
      safety: 1,
      idiomatic: 1,
    });
    expect(summary.postedCommentCount).toBe(0);
    expect(summary.skippedByConfidence).toBe(1);
    expect(summary.skippedByCap).toBe(1);
    expect(summary.checkOutput?.title).toContain("0 posted of 3");
  });
});

describe("applyFindingGates", () => {
  test("drops below-threshold findings and preserves highest-confidence-first ordering", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("finding-below-threshold", 0.49, "clean"),
      createFinding("finding-middle", 0.7, "perf"),
      createFinding("finding-late-high", 0.99, "safety"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0.5,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "finding-late-high",
      "finding-middle",
    ]);
    expect(gatedResult.summary.totalFindings).toBe(2);
  });

  test("does not apply max-comments truncation inside confidence gating", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("finding-low", 0.8, "clean"),
      createFinding("finding-top", 0.99, "perf"),
      createFinding("finding-mid", 0.95, "safety"),
      createFinding("finding-lower", 0.81, "idiomatic"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "finding-top",
      "finding-mid",
      "finding-lower",
      "finding-low",
    ]);
    expect(gatedResult.summary.totalFindings).toBe(4);
  });

  test("uses deterministic tie ordering for equal-confidence findings", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("z-finding", 0.9, "clean"),
      createFinding("a-finding", 0.9, "perf"),
      createFinding("m-finding", 0.9, "safety"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "a-finding",
      "m-finding",
      "z-finding",
    ]);
  });
});

describe("finding delivery", () => {
  const baseFinding = {
    installationId: 1,
    repo: "acme/widget",
    prNumber: 3,
    language: "typescript",
    category: "safety" as const,
    status: "posted" as const,
  };

  test("prepareFindingDelivery deduplicates by stable key and applies bounded cap", () => {
    const findings = [
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.9,
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.88,
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: "rule/b",
        filePath: "src/b.ts",
        line: 2,
        evidence: "const b: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.87,
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: "rule/c",
        filePath: "src/c.ts",
        line: 3,
        evidence: "const c: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.86,
      },
      {
        ...baseFinding,
        findingId: "below-threshold",
        ruleId: "rule/d",
        filePath: "src/d.ts",
        line: 4,
        evidence: "const d: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.4,
      },
    ];

    const delivery = prepareFindingDelivery(findings, {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });

    expect(delivery.comments).toHaveLength(2);
    expect(delivery.skippedByConfidence).toBe(1);
    expect(delivery.skippedByDeduplication).toBe(1);
    expect(delivery.skippedByCap).toBe(1);
    expect(delivery.comments[0]!.dedupeKey).toBe("acme/widget#3:same-key");
    expect(delivery.comments[1]!.dedupeKey).toBe("acme/widget#3:cap-1");
  });

  test("prepareFindingDelivery ordering is deterministic across input permutations", () => {
    const findings = [
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.9,
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.88,
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: "rule/b",
        filePath: "src/b.ts",
        line: 2,
        evidence: "const b: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.87,
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: "rule/c",
        filePath: "src/c.ts",
        line: 3,
        evidence: "const c: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.86,
      },
    ];

    const forwardOrderDelivery = prepareFindingDelivery(findings, {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });
    const reverseOrderDelivery = prepareFindingDelivery([...findings].reverse(), {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });

    expect(forwardOrderDelivery.comments.map((comment) => comment.dedupeKey)).toEqual([
      "acme/widget#3:same-key",
      "acme/widget#3:cap-1",
    ]);
    expect(reverseOrderDelivery.comments.map((comment) => comment.dedupeKey)).toEqual([
      "acme/widget#3:same-key",
      "acme/widget#3:cap-1",
    ]);
    expect(reverseOrderDelivery).toEqual(forwardOrderDelivery);
  });

  test("postPreparedFindingComments only posts prepared bounded payload", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 1,
          evidence: "const b: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.89,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 1,
      },
    );

    const postedBodies: string[] = [];
    const postingResult = await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        installationAccessToken: "token",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
      },
      {
        postPullRequestSummaryCommentFn: async (options) => {
          postedBodies.push(options.body);
          return {
            id: 1,
            html_url: "https://github.com/acme/widget/pull/3#issuecomment-1",
            body: options.body,
          };
        },
      },
    );

    expect(postingResult.postedCount).toBe(1);
    expect(postingResult.successes).toHaveLength(1);
    expect(postingResult.failures).toHaveLength(0);
    expect(postedBodies).toHaveLength(1);
    expect(postedBodies[0]!).toContain("\"dedupeKey\": \"acme/widget#3:one\"");
    expect(postingResult.successes[0]!.requestOptions.installationAccessToken).toBe("[REDACTED]");
  });

  test("postPreparedFindingComments reports partial failures without throwing", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 1,
          evidence: "const b: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.89,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 2,
      },
    );

    const loggedErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (value?: unknown): void => {
      loggedErrors.push(String(value));
    };

    try {
      const postingResult = await postPreparedFindingComments(
        {
          owner: "acme",
          repository: "widget",
          pullRequestNumber: 3,
          installationAccessToken: "token",
          githubFetchOptions: workerFetchOptions,
          comments: delivery.comments,
        },
        {
          postPullRequestSummaryCommentFn: async (options) => {
            if (options.body.includes("\"dedupeKey\": \"acme/widget#3:two\"")) {
              throw new Error("secondary post failed");
            }

            return {
              id: 1,
              html_url: "https://github.com/acme/widget/pull/3#issuecomment-1",
              body: options.body,
            };
          },
        },
      );

      expect(postingResult.postedCount).toBe(1);
      expect(postingResult.successes).toHaveLength(1);
      expect(postingResult.failures).toHaveLength(1);
      expect(postingResult.successes[0]!.index).toBe(0);
      expect(postingResult.failures[0]!.index).toBe(1);
      expect(postingResult.failures[0]!.errorMessage).toBe("secondary post failed");
      expect(postingResult.failures[0]!.preparedComment.dedupeKey).toBe("acme/widget#3:two");
      expect(postingResult.failures[0]!.requestOptions.installationAccessToken).toBe("[REDACTED]");
      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0]!).toContain("acme/widget#3:two");
      expect(loggedErrors[0]!).toContain("[REDACTED]");
      expect(loggedErrors[0]!).not.toContain("\"installationAccessToken\":\"token\"");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("buildWorkerCheckOutput includes structured skip counters", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.6,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 20,
      },
    );

    const checkOutput = buildWorkerCheckOutput(
      {
        findings: [],
        summary: {
          totalRules: 3,
          successfulRules: 3,
          failedRules: 0,
          totalFindings: 1,
          findingsByCategory: {
            clean: 0,
            perf: 0,
            safety: 1,
            idiomatic: 0,
          },
        },
        failedRuleIds: [],
      },
      delivery,
      0,
    );

    expect(checkOutput.title).toContain("0 posted of 1");
    expect(checkOutput.summary).toContain("Rules=3/3");
    expect(checkOutput.text).toContain("skipped_by_confidence=1");
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
    delete process.env.WORKER_FINDING_CONFIDENCE_THRESHOLD;
    delete process.env.WORKER_FINDING_MAX_COMMENTS;

    const config = loadConfig();

    expect(config.pollIntervalMs).toBe(3000);
    expect(config.maxProcessedKeys).toBe(10000);
    expect(config.githubApiBaseUrl).toBe("https://api.github.com");
    expect(config.githubUserAgent).toBe("mergewise-worker");
    expect(config.githubRequestTimeoutMs).toBe(10000);
    expect(config.githubFetchRetries).toBe(2);
    expect(config.githubRetryDelayMs).toBe(250);
    expect(config.confidenceThreshold).toBe(0.78);
    expect(config.maxComments).toBe(20);
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

  test("throws for invalid confidence threshold", () => {
    process.env.WORKER_FINDING_CONFIDENCE_THRESHOLD = "2";
    expect(() => loadConfig()).toThrow("Invalid WORKER_FINDING_CONFIDENCE_THRESHOLD value");
  });

  test("throws for invalid max comments", () => {
    process.env.WORKER_FINDING_MAX_COMMENTS = "0";
    expect(() => loadConfig()).toThrow("Invalid WORKER_FINDING_MAX_COMMENTS value");
  });
});
