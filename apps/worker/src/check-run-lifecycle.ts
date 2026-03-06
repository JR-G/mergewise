import {
  fetchPullRequest,
  createCheckRun,
  updateCheckRun,
  type GitHubPullRequest,
  type CreateCheckRunOptions,
  type UpdateCheckRunOptions,
  type GitHubCheckRun,
} from "@mergewise/github-client";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";
import type { WorkerGitHubFetchOptions } from "./config";
import type { AnalyzePullRequestJobSummary } from "./job-utils";
import { buildSkippedJobSummary } from "./job-utils";
import type { buildWorkerCheckOutput } from "./delivery";
import type { GitHubAnalysisContextResult } from "./github-fetch";
import type { WorkerProcessingDependencies, ResolvedLoggers } from "./process-job-types";

export interface CheckRunContext {
  readonly job: AnalyzePullRequestJob;
  readonly githubAnalysisContext: GitHubAnalysisContextResult;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly traceId: string;
  readonly loggers: ResolvedLoggers;
}

interface FetchPrStateOptions {
  readonly job: AnalyzePullRequestJob;
  readonly githubAnalysisContext: GitHubAnalysisContextResult;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly traceId: string;
}

/**
 * Fetches the current state of a pull request, reporting check run failures on error.
 */
export async function fetchPullRequestState(
  options: FetchPrStateOptions,
  dependencies: WorkerProcessingDependencies,
): Promise<GitHubPullRequest> {
  const fetchPullRequestFn = dependencies.fetchPullRequestFn ?? fetchPullRequest;
  const updateCheckRunFn = dependencies.updateCheckRunFn ?? updateCheckRun;
  const errorLogger = dependencies.logError ?? console.error;

  try {
    return await fetchPullRequestFn({
      owner: options.githubAnalysisContext.owner,
      repository: options.githubAnalysisContext.repository,
      pullRequestNumber: options.job.pr_number,
      installationAccessToken: options.githubAnalysisContext.installationAccessToken,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    });
  } catch (fetchPrError) {
    const detail = fetchPrError instanceof Error
      ? fetchPrError.stack ?? fetchPrError.message
      : String(fetchPrError);
    errorLogger(
      `[worker] fetchPullRequest failed trace=${options.traceId} job=${options.job.job_id}: ${detail}`,
    );
    await reportFetchPrFailureCheckRun(options, updateCheckRunFn, errorLogger);
    throw fetchPrError;
  }
}

async function reportFetchPrFailureCheckRun(
  options: FetchPrStateOptions,
  updateCheckRunFn: (opts: UpdateCheckRunOptions) => Promise<GitHubCheckRun>,
  errorLogger: (message: string) => void,
): Promise<void> {
  if (options.job.check_run_id === undefined) {
    return;
  }

  try {
    await updateCheckRunFn({
      owner: options.githubAnalysisContext.owner,
      repository: options.githubAnalysisContext.repository,
      checkRunId: options.job.check_run_id,
      installationAccessToken: options.githubAnalysisContext.installationAccessToken,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Review failed",
        summary: "Failed to fetch pull request state.",
      },
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    });
  } catch (checkRunError) {
    const checkDetail = checkRunError instanceof Error
      ? checkRunError.message
      : String(checkRunError);
    errorLogger(
      `[worker] failed to complete errored check run trace=${options.traceId} job=${options.job.job_id}: ${checkDetail}`,
    );
  }
}

/**
 * Handles the early exit when a pull request is closed or merged.
 */
export async function handleClosedPullRequestExit(
  ctx: CheckRunContext,
  pullRequestState: GitHubPullRequest,
  dependencies: WorkerProcessingDependencies,
): Promise<AnalyzePullRequestJobSummary> {
  ctx.loggers.infoLogger(
    `[worker] skipped_closed_pr trace=${ctx.traceId} job=${ctx.job.job_id} state=${pullRequestState.state} merged=${String(pullRequestState.merged)}`,
  );
  if (dependencies.deliveryMode === "github") {
    await updateCheckRunForClosedPr(ctx, dependencies.updateCheckRunFn ?? updateCheckRun);
  }
  return buildSkippedJobSummary(ctx.job, ctx.traceId, "pr_not_open", dependencies.now);
}

async function updateCheckRunForClosedPr(
  ctx: CheckRunContext,
  updateCheckRunFn: (opts: UpdateCheckRunOptions) => Promise<GitHubCheckRun>,
): Promise<void> {
  const queuedCheckRunId = ctx.job.check_run_id;
  if (queuedCheckRunId === undefined) {
    return;
  }

  try {
    await updateCheckRunFn({
      owner: ctx.githubAnalysisContext.owner,
      repository: ctx.githubAnalysisContext.repository,
      checkRunId: queuedCheckRunId,
      installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review skipped", summary: "Pull request is no longer open." },
      apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
      userAgent: ctx.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
      traceId: ctx.traceId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.loggers.errorLogger(
      `[worker] failed to complete skipped check run trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`,
    );
  }
}

/**
 * Ensures a GitHub check run is moved to in-progress status.
 */
export async function ensureCheckRunInProgress(
  ctx: CheckRunContext,
  dependencies: WorkerProcessingDependencies,
): Promise<number | undefined> {
  const createCheckRunFn = dependencies.createCheckRunFn ?? createCheckRun;
  const updateCheckRunFn = dependencies.updateCheckRunFn ?? updateCheckRun;

  try {
    if (ctx.job.check_run_id !== undefined) {
      return await markExistingCheckRunInProgress(ctx, ctx.job.check_run_id, updateCheckRunFn);
    }
    return await createNewCheckRunInProgress(ctx, createCheckRunFn);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.loggers.errorLogger(
      `[worker] failed to create in-progress check run trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`,
    );
    return undefined;
  }
}

async function markExistingCheckRunInProgress(
  ctx: CheckRunContext,
  checkRunId: number,
  updateCheckRunFn: (opts: UpdateCheckRunOptions) => Promise<GitHubCheckRun>,
): Promise<number> {
  await updateCheckRunFn({
    owner: ctx.githubAnalysisContext.owner,
    repository: ctx.githubAnalysisContext.repository,
    checkRunId,
    installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
    status: "in_progress",
    output: { title: "Review in progress", summary: "Analysing pull request..." },
    apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
    userAgent: ctx.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
    traceId: ctx.traceId,
  });
  ctx.loggers.infoLogger(
    `[worker] check_run_in_progress trace=${ctx.traceId} job=${ctx.job.job_id} checkRunId=${checkRunId}`,
  );
  return checkRunId;
}

async function createNewCheckRunInProgress(
  ctx: CheckRunContext,
  createCheckRunFn: (opts: CreateCheckRunOptions) => Promise<GitHubCheckRun>,
): Promise<number> {
  const pendingCheckRun = await createCheckRunFn({
    owner: ctx.githubAnalysisContext.owner,
    repository: ctx.githubAnalysisContext.repository,
    headSha: ctx.job.head_sha,
    installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
    name: "Mergewise",
    status: "in_progress",
    output: { title: "Review in progress", summary: "Analysing pull request..." },
    apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
    userAgent: ctx.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
    traceId: ctx.traceId,
  });
  ctx.loggers.infoLogger(
    `[worker] check_run_in_progress trace=${ctx.traceId} job=${ctx.job.job_id} checkRunId=${pendingCheckRun.id}`,
  );
  return pendingCheckRun.id;
}

/**
 * Completes a GitHub check run with success conclusion.
 */
export async function finaliseCheckRun(
  ctx: CheckRunContext,
  pendingCheckRunId: number | undefined,
  checkOutput: ReturnType<typeof buildWorkerCheckOutput>,
  dependencies: WorkerProcessingDependencies,
): Promise<void> {
  const createCheckRunFn = dependencies.createCheckRunFn ?? createCheckRun;
  const updateCheckRunFn = dependencies.updateCheckRunFn ?? updateCheckRun;

  try {
    if (pendingCheckRunId !== undefined) {
      await updateCheckRunFn({
        owner: ctx.githubAnalysisContext.owner,
        repository: ctx.githubAnalysisContext.repository,
        checkRunId: pendingCheckRunId,
        installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
        status: "completed",
        conclusion: "success",
        output: checkOutput,
        apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
        userAgent: ctx.githubFetchOptions.githubUserAgent,
        requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
        traceId: ctx.traceId,
      });
    } else {
      await createCheckRunFn({
        owner: ctx.githubAnalysisContext.owner,
        repository: ctx.githubAnalysisContext.repository,
        headSha: ctx.job.head_sha,
        installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
        name: "Mergewise",
        conclusion: "success",
        output: checkOutput,
        apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
        userAgent: ctx.githubFetchOptions.githubUserAgent,
        requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
        traceId: ctx.traceId,
      });
    }
    ctx.loggers.infoLogger(
      `[worker] check_run_completed trace=${ctx.traceId} job=${ctx.job.job_id}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.loggers.errorLogger(
      `[worker] check_run_failed trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`,
    );
  }
}
