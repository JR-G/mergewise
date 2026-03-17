import { describe, expect, it } from "bun:test";

import type { AnalyzePullRequestJob } from "@mergewise/shared-types";
import { toInstallationId, toJobId, toPRNumber, toRepoFullName, toSHA } from "@mergewise/shared-types";
import type { GitHubCheckRun } from "@mergewise/github-client";
import type { WorkerProcessingDependencies, ResolvedLoggers } from "./process-job-types";
import type { GitHubAnalysisContextResult } from "./github-fetch";
import type { WorkerGitHubFetchOptions } from "./config";
import type { CheckRunContext } from "./check-run-lifecycle";
import {
  fetchPullRequestState,
  handleClosedPullRequestExit,
  ensureCheckRunInProgress,
  finaliseCheckRun,
} from "./check-run-lifecycle";

function buildStubJob(overrides: Partial<AnalyzePullRequestJob> = {}): AnalyzePullRequestJob {
  return {
    job_id: toJobId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    installation_id: toInstallationId(100),
    repo_full_name: toRepoFullName("acme/repo"),
    pr_number: toPRNumber(7),
    head_sha: toSHA("a".repeat(40)),
    queued_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function buildStubGitHubFetchOptions(): WorkerGitHubFetchOptions {
  return {
    githubApiBaseUrl: "https://api.github.com",
    githubUserAgent: "test-agent",
    githubRequestTimeoutMs: 5000,
    githubFetchRetries: 1,
    githubRetryDelayMs: 50,
  };
}

function buildStubAnalysisContext(): GitHubAnalysisContextResult {
  return {
    analysisContext: {
      diffs: [],
      pullRequest: {
        repo: toRepoFullName("acme/repo"),
        prNumber: toPRNumber(7),
        headSha: toSHA("a".repeat(40)),
        installationId: toInstallationId(100),
      },
    },
    owner: "acme",
    repository: "repo",
    installationAccessToken: "ghs_token",
  };
}

function buildStubCheckRun(id: number): GitHubCheckRun {
  return { id, html_url: "https://github.com/check", status: "completed", conclusion: "success" };
}

function buildStubLoggers(): ResolvedLoggers {
  return {
    infoLogger: () => {},
    errorLogger: () => {},
    warnLogger: () => {},
  };
}

function buildStubContext(overrides: Partial<CheckRunContext> = {}): CheckRunContext {
  return {
    job: buildStubJob(),
    githubAnalysisContext: buildStubAnalysisContext(),
    githubFetchOptions: buildStubGitHubFetchOptions(),
    traceId: "trace-1",
    loggers: buildStubLoggers(),
    ...overrides,
  };
}

describe("fetchPullRequestState", () => {
  it("returns the pull request when fetch succeeds", async () => {
    const pullRequest = { number: 7, state: "open" as const, merged: false, title: "feat: add widget", head: { sha: "abc123" } };
    const dependencies: WorkerProcessingDependencies = {
      fetchPullRequestFn: async () => pullRequest,
    };

    const result = await fetchPullRequestState(
      { job: buildStubJob(), githubAnalysisContext: buildStubAnalysisContext(), githubFetchOptions: buildStubGitHubFetchOptions(), traceId: "trace-1" },
      dependencies,
    );

    expect(result.state).toBe("open");
    expect(result.number).toBe(7);
  });

  it("re-throws the fetch error after reporting failure", async () => {
    const dependencies: WorkerProcessingDependencies = {
      fetchPullRequestFn: async () => { throw new Error("network timeout"); },
      updateCheckRunFn: async () => buildStubCheckRun(1),
      logError: () => {},
    };

    let thrownError: unknown;
    try {
      await fetchPullRequestState(
        { job: buildStubJob({ check_run_id: 1 }), githubAnalysisContext: buildStubAnalysisContext(), githubFetchOptions: buildStubGitHubFetchOptions(), traceId: "trace-1" },
        dependencies,
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("network timeout");
  });

  it("skips check run update when job has no check_run_id", async () => {
    let updateCalled = false;
    const dependencies: WorkerProcessingDependencies = {
      fetchPullRequestFn: async () => { throw new Error("fail"); },
      updateCheckRunFn: async () => { updateCalled = true; return buildStubCheckRun(1); },
      logError: () => {},
    };

    await fetchPullRequestState(
      { job: buildStubJob(), githubAnalysisContext: buildStubAnalysisContext(), githubFetchOptions: buildStubGitHubFetchOptions(), traceId: "trace-1" },
      dependencies,
    ).catch(() => {});

    expect(updateCalled).toBe(false);
  });
});

describe("handleClosedPullRequestExit", () => {
  it("returns a skipped summary with zeroed counters", async () => {
    const closedPr = { number: 7, state: "closed" as const, merged: true, title: "old pr", head: { sha: "abc123" } };
    const fixedDate = new Date("2025-06-01T12:00:00Z");
    const dependencies: WorkerProcessingDependencies = {
      deliveryMode: "none",
      now: () => fixedDate,
    };

    const result = await handleClosedPullRequestExit(buildStubContext(), closedPr, dependencies);

    expect(result.totalFindings).toBe(0);
    expect(result.totalRules).toBe(0);
    expect(result.processedAt).toBe(fixedDate.toISOString());
  });

  it("updates check run when delivery mode is github", async () => {
    const closedPr = { number: 7, state: "closed" as const, merged: false, title: "closed pr", head: { sha: "abc123" } };
    let updateConclusion: string | undefined;
    const dependencies: WorkerProcessingDependencies = {
      deliveryMode: "github",
      updateCheckRunFn: async (opts) => { updateConclusion = opts.conclusion; return buildStubCheckRun(1); },
      now: () => new Date("2025-06-01T12:00:00Z"),
    };

    await handleClosedPullRequestExit(
      buildStubContext({ job: buildStubJob({ check_run_id: 1 }) }),
      closedPr,
      dependencies,
    );

    expect(updateConclusion).toBe("neutral");
  });
});

describe("ensureCheckRunInProgress", () => {
  it("updates an existing check run and returns its id", async () => {
    let updatedStatus: string | undefined;
    const dependencies: WorkerProcessingDependencies = {
      updateCheckRunFn: async (opts) => { updatedStatus = opts.status; return buildStubCheckRun(42); },
    };

    const result = await ensureCheckRunInProgress(
      buildStubContext({ job: buildStubJob({ check_run_id: 42 }) }),
      dependencies,
    );

    expect(result).toBe(42);
    expect(updatedStatus).toBe("in_progress");
  });

  it("creates a new check run when no check_run_id exists", async () => {
    const dependencies: WorkerProcessingDependencies = {
      createCheckRunFn: async () => buildStubCheckRun(99),
    };

    const result = await ensureCheckRunInProgress(buildStubContext(), dependencies);

    expect(result).toBe(99);
  });

  it("returns undefined when the check run operation fails", async () => {
    const dependencies: WorkerProcessingDependencies = {
      createCheckRunFn: async () => { throw new Error("permission denied"); },
      logError: () => {},
    };

    const result = await ensureCheckRunInProgress(buildStubContext(), dependencies);

    expect(result).toBeUndefined();
  });
});

describe("finaliseCheckRun", () => {
  it("updates an existing pending check run with success conclusion", async () => {
    let capturedConclusion: string | undefined;
    const dependencies: WorkerProcessingDependencies = {
      updateCheckRunFn: async (opts) => { capturedConclusion = opts.conclusion; return buildStubCheckRun(10); },
    };
    const checkOutput = { title: "Review complete", summary: "All good", text: "" };

    await finaliseCheckRun(buildStubContext(), 10, checkOutput, dependencies);

    expect(capturedConclusion).toBe("success");
  });

  it("creates a new check run when no pending id is provided", async () => {
    let createCalled = false;
    const dependencies: WorkerProcessingDependencies = {
      createCheckRunFn: async () => { createCalled = true; return buildStubCheckRun(50); },
    };
    const checkOutput = { title: "Review complete", summary: "Done", text: "" };

    await finaliseCheckRun(buildStubContext(), undefined, checkOutput, dependencies);

    expect(createCalled).toBe(true);
  });

  it("logs the error without throwing when finalisation fails", async () => {
    let errorLogged = false;
    const loggers: ResolvedLoggers = {
      infoLogger: () => {},
      errorLogger: () => { errorLogged = true; },
      warnLogger: () => {},
    };
    const dependencies: WorkerProcessingDependencies = {
      updateCheckRunFn: async () => { throw new Error("API down"); },
    };
    const checkOutput = { title: "Review complete", summary: "Done", text: "" };

    await finaliseCheckRun(
      buildStubContext({ loggers }),
      5,
      checkOutput,
      dependencies,
    );

    expect(errorLogged).toBe(true);
  });
});
