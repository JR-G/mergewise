import {
  listPullRequestReviewThreads,
  listPullRequestSummaryComments,
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  type FetchPullRequestFilesOptions,
  type GitHubIssueComment,
  type GitHubPullRequestReview,
  type GitHubPullRequestFile,
  type ListPullRequestCommentsOptions,
  type ListPullRequestReviewThreadsOptions,
  type CreatePullRequestReviewOptions,
  type ResolveReviewThreadOptions,
  type ResolveReviewThreadResult,
  type ReviewThread,
  type PostPullRequestSummaryCommentOptions,
  type UpdateIssueCommentOptions,
  fetchFileContent,
  fetchPullRequest,
  createCheckRun,
  updateCheckRun,
  type FetchPullRequestOptions,
  type GitHubPullRequest,
  type CreateCheckRunOptions,
  type UpdateCheckRunOptions,
  type GitHubCheckRun,
} from "@mergewise/github-client";
import {
  DEFAULT_MERGEWISE_CONFIG,
  type MergewiseConfig,
} from "@mergewise/config-loader";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { executeRules } from "@mergewise/rule-engine";
import { tsReactRules } from "@mergewise/rule-ts-react";
import { createLlmReviewerRule } from "@mergewise/llm-reviewer";
import type {
  AnalysisContext,
  AnalyzePullRequestJob,
  CodebaseContext,
  Rule,
} from "@mergewise/shared-types";
import {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
  resolveGitHubFetchOptions,
  type WorkerGitHubFetchOptions,
} from "./config";
import {
  buildAnalysisContext,
  mapGitHubPullRequestFilesToDiffs,
} from "./diff-parser";
import { loadGitHubAppCredentials } from "./github-auth";
import {
  type AnalyzePullRequestJobSummary,
  buildIdempotencyKey,
  resolveJobTraceId,
  parseRepositoryFullName,
  buildJobSummary,
  buildSkippedJobSummary,
  selectRulesForExecution,
  applyFindingGates,
} from "./job-utils";
import {
  type WorkerFindingDeliveryOptions,
  prepareFindingDelivery,
  buildWorkerCheckOutput,
} from "./delivery";
import {
  loadExistingDedupeKeys,
  collectCommentFeedback,
  logFeedbackSummary,
  postPreparedFindingComments,
  resolveOutdatedComments,
} from "./pr-comments";
import {
  buildPrSummaryComment,
  upsertPrSummaryComment,
} from "./pr-summary";

/**
 * Dependency hooks for retryable pull request file fetch.
 */
export interface PullRequestFileRetryDependencies {
  /**
   * GitHub client function for fetching pull request files.
   */
  readonly fetchPullRequestFiles: (
    options: FetchPullRequestFilesOptions,
  ) => Promise<GitHubPullRequestFile[]>;
  /**
   * Async delay function used between retry attempts.
   */
  readonly sleep: (delayMs: number) => Promise<void>;
  /**
   * Warning logger for retry attempts.
   */
  readonly logWarn?: (message: string) => void;
  /**
   * Info logger fallback when warning logger is not provided.
   */
  readonly logInfo?: (message: string) => void;
  /**
   * Error logger fallback when warning/info loggers are not provided.
   */
  readonly logError?: (message: string) => void;
}

/**
 * Dependency overrides for job processing.
 */
export interface WorkerProcessingDependencies {
  /**
   * Rules to execute for pull request analysis.
   */
  readonly rules?: readonly Rule[];
  /**
   * Rule execution function override for testing.
   */
  readonly executeRulesFn?: (
    options: {
      readonly context: AnalysisContext;
      readonly rules: readonly Rule[];
      readonly codebaseContext?: CodebaseContext;
      readonly onRuleExecutionError?: (rule: Rule, error: unknown) => void;
    },
  ) => Promise<RuleExecutionResult>;
  /**
   * Optional override for resolved GitHub fetch options.
   */
  readonly githubFetchOptions?: WorkerGitHubFetchOptions;
  /**
   * GitHub App JWT creation function override.
   */
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  /**
   * Installation token exchange function override.
   */
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  /**
   * Retryable pull request file fetch function override.
   */
  readonly fetchPullRequestFilesWithRetryFn?: typeof fetchPullRequestFilesWithRetry;
  /**
   * Info logger for operational events.
   */
  readonly logInfo?: (message: string) => void;
  /**
   * Error logger for operational events.
   */
  readonly logError?: (message: string) => void;
  /**
   * Warning logger for retryable operational events.
   */
  readonly logWarn?: (message: string) => void;
  /**
   * Time source override for deterministic testing.
   */
  readonly now?: () => Date;
  /**
   * Whether to post findings to GitHub after rule execution.
   */
  readonly deliveryMode?: "none" | "github";
  /**
   * Delivery thresholds for confidence gating and posting cap.
   */
  readonly findingDeliveryOptions?: WorkerFindingDeliveryOptions;
  /**
   * Batch pull request review creation function override.
   */
  readonly createPullRequestReviewFn?: (
    options: CreatePullRequestReviewOptions,
  ) => Promise<GitHubPullRequestReview>;
  /**
   * GitHub check run creation function override.
   */
  readonly createCheckRunFn?: (
    options: CreateCheckRunOptions,
  ) => Promise<GitHubCheckRun>;
  /**
   * GitHub check run update function override.
   */
  readonly updateCheckRunFn?: (
    options: UpdateCheckRunOptions,
  ) => Promise<GitHubCheckRun>;
  /**
   * Review thread resolution function override for testing.
   */
  readonly resolveReviewThreadFn?: (
    options: ResolveReviewThreadOptions,
  ) => Promise<ResolveReviewThreadResult>;
  /**
   * Summary comment listing function override for testing.
   */
  readonly listPullRequestSummaryCommentsFn?: (
    options: ListPullRequestCommentsOptions,
  ) => Promise<GitHubIssueComment[]>;
  /**
   * Review thread listing function override for testing.
   */
  readonly listPullRequestReviewThreadsFn?: (
    options: ListPullRequestReviewThreadsOptions,
  ) => Promise<ReviewThread[]>;
  /**
   * Pull request state fetch function override.
   */
  readonly fetchPullRequestFn?: (
    options: FetchPullRequestOptions,
  ) => Promise<GitHubPullRequest>;
  /**
   * Runtime rule selection and gating config.
   */
  readonly mergewiseConfig?: MergewiseConfig;
  /**
   * Summary comment creation function override for testing.
   */
  readonly postPullRequestSummaryCommentFn?: (
    options: PostPullRequestSummaryCommentOptions,
  ) => Promise<GitHubIssueComment>;
  /**
   * Issue comment update function override for testing.
   */
  readonly updateIssueCommentFn?: (
    options: UpdateIssueCommentOptions,
  ) => Promise<GitHubIssueComment>;
}

/**
 * Fetches pull request files with bounded retries for transient failures.
 *
 * @param options - GitHub file fetch options.
 * @param maxRetries - Maximum retry count after the initial attempt.
 * @param retryDelayMs - Delay between retries in milliseconds.
 * @param dependencies - Test hooks for network call and delay behavior.
 * @returns Pull request files returned by GitHub.
 */
export async function fetchPullRequestFilesWithRetry(
  options: FetchPullRequestFilesOptions,
  maxRetries: number,
  retryDelayMs: number,
  dependencies: PullRequestFileRetryDependencies = {
    fetchPullRequestFiles,
    sleep: defaultSleep,
  },
): Promise<GitHubPullRequestFile[]> {
  const totalAttempts = maxRetries + 1;
  const errorLogger =
    dependencies.logWarn ?? dependencies.logInfo ?? dependencies.logError ?? console.warn;

  for (let attemptNumber = 1; attemptNumber <= totalAttempts; attemptNumber += 1) {
    try {
      return await dependencies.fetchPullRequestFiles(options);
    } catch (error) {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(
        `[worker] GitHub PR file fetch failed attempt=${attemptNumber}/${totalAttempts}: ${details}`,
      );

      const isLastAttempt = attemptNumber === totalAttempts;
      const isRetryable = isRetryablePullRequestFileFetchError(error);

      if (isLastAttempt || !isRetryable) {
        throw error;
      }

      errorLogger(
        `[worker] retrying GitHub PR file fetch attempt=${attemptNumber}/${totalAttempts} retryable=${String(isRetryable)}`,
      );
      await dependencies.sleep(retryDelayMs);
    }
  }

  throw new Error("Unreachable: retry loop exited without returning or throwing");
}

/**
 * Processes a queued analysis job through GitHub fetch, rule execution, and summary generation.
 *
 * @param job - Job payload to process.
 * @param dependencies - Optional dependency overrides.
 * @returns Deterministic processing summary for this job.
 */
export async function processAnalyzePullRequestJob(
  job: AnalyzePullRequestJob,
  dependencies: WorkerProcessingDependencies = {},
): Promise<AnalyzePullRequestJobSummary> {
  const key = buildIdempotencyKey(job);
  const traceId = resolveJobTraceId(job);
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;
  const warnLogger = dependencies.logWarn ?? infoLogger;
  const mergewiseConfigResolved = dependencies.mergewiseConfig ?? DEFAULT_MERGEWISE_CONFIG;
  const llmConfig = mergewiseConfigResolved.llm;
  const reviewConfig = mergewiseConfigResolved.review;
  const llmApiKey = process.env.LLM_API_KEY;
  const llmEnabled = llmConfig.enabled && llmApiKey !== undefined && llmApiKey.length > 0;

  const baseLlmRules: readonly Rule[] = llmEnabled && llmApiKey
    ? [
        createLlmReviewerRule({
          clientConfig: {
            apiKey: llmApiKey,
            baseUrl: llmConfig.baseUrl,
            model: llmConfig.model,
          },
          tokenBudget: llmConfig.tokenBudget,
          userSkipPatterns: reviewConfig.skipPatterns.length > 0 ? reviewConfig.skipPatterns : undefined,
          confidenceThreshold: mergewiseConfigResolved.gating.confidenceThreshold,
          onFileReviewError: (filePath, error) => {
            warnLogger(
              `[worker] llm review failed trace=${traceId} file=${filePath} error=${error instanceof Error ? error.message : String(error)}`,
            );
          },
          onFileReviewComplete: (filePath, findingCount, promptTokens, completionTokens) => {
            infoLogger(
              `[worker] llm_usage trace=${traceId} file=${filePath} findings=${findingCount} prompt_tokens=${promptTokens} completion_tokens=${completionTokens} total_tokens=${promptTokens + completionTokens}`,
            );
          },
        }),
      ]
    : [];

  const rules = dependencies.rules ?? [...tsReactRules, ...baseLlmRules];
  const selectedRules = selectRulesForExecution(rules, mergewiseConfigResolved);
  const executeRulesFn = dependencies.executeRulesFn ?? executeRules;
  const githubFetchOptions = dependencies.githubFetchOptions ?? resolveGitHubFetchOptions();
  const findingDeliveryOptions = dependencies.findingDeliveryOptions ?? {
    confidenceThreshold: mergewiseConfigResolved.gating.confidenceThreshold,
    maxComments: mergewiseConfigResolved.gating.maxComments,
    testFileConfidenceThreshold: DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
    allowedCategories: DEFAULT_ALLOWED_POST_CATEGORIES,
    blockedRuleIds: DEFAULT_BLOCKED_POST_RULE_IDS,
  };

  infoLogger(
    `[worker] processing trace=${traceId} job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"} rules=${selectedRules.length}`,
  );

  const githubAnalysisContext = await buildAnalysisContextFromGitHub(
    job,
    githubFetchOptions,
    {
      createGitHubAppJwtFn: dependencies.createGitHubAppJwtFn,
      exchangeInstallationAccessTokenFn: dependencies.exchangeInstallationAccessTokenFn,
      fetchPullRequestFilesWithRetryFn: dependencies.fetchPullRequestFilesWithRetryFn,
      logWarn: warnLogger,
      logInfo: infoLogger,
      logError: errorLogger,
    },
  );

  const createCheckRunFn = dependencies.createCheckRunFn ?? createCheckRun;
  const updateCheckRunFn = dependencies.updateCheckRunFn ?? updateCheckRun;

  const fetchPullRequestFn = dependencies.fetchPullRequestFn ?? fetchPullRequest;
  let pullRequestState: Awaited<ReturnType<typeof fetchPullRequestFn>>;
  try {
    pullRequestState = await fetchPullRequestFn({
      owner: githubAnalysisContext.owner,
      repository: githubAnalysisContext.repository,
      pullRequestNumber: job.pr_number,
      installationAccessToken: githubAnalysisContext.installationAccessToken,
      apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
      userAgent: githubFetchOptions.githubUserAgent,
      requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
      traceId,
    });
  } catch (fetchPrError) {
    const detail = fetchPrError instanceof Error
      ? fetchPrError.stack ?? fetchPrError.message
      : String(fetchPrError);
    errorLogger(
      `[worker] fetchPullRequest failed trace=${traceId} job=${job.job_id}: ${detail}`,
    );
    if (dependencies.deliveryMode === "github" && job.check_run_id !== undefined) {
      try {
        await updateCheckRunFn({
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          checkRunId: job.check_run_id,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          status: "completed",
          conclusion: "failure",
          output: {
            title: "Review failed",
            summary: "Failed to fetch pull request state.",
          },
          apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
          userAgent: githubFetchOptions.githubUserAgent,
          requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
          traceId,
        });
      } catch (checkRunError) {
        const checkDetail = checkRunError instanceof Error
          ? checkRunError.message
          : String(checkRunError);
        errorLogger(
          `[worker] failed to complete errored check run trace=${traceId} job=${job.job_id}: ${checkDetail}`,
        );
      }
    }
    throw fetchPrError;
  }

  const isPrClosed = pullRequestState.state !== "open";
  const queuedCheckRunId =
    dependencies.deliveryMode === "github" ? job.check_run_id : undefined;

  if (isPrClosed) {
    infoLogger(
      `[worker] skipped_closed_pr trace=${traceId} job=${job.job_id} state=${pullRequestState.state} merged=${String(pullRequestState.merged)}`,
    );
  }

  if (isPrClosed && queuedCheckRunId !== undefined) {
    try {
      await updateCheckRunFn({
        owner: githubAnalysisContext.owner,
        repository: githubAnalysisContext.repository,
        checkRunId: queuedCheckRunId,
        installationAccessToken: githubAnalysisContext.installationAccessToken,
        status: "completed",
        conclusion: "neutral",
        output: { title: "Review skipped", summary: "Pull request is no longer open." },
        apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
        userAgent: githubFetchOptions.githubUserAgent,
        requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
        traceId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorLogger(
        `[worker] failed to complete skipped check run trace=${traceId} job=${job.job_id}: ${detail}`,
      );
    }
  }

  if (isPrClosed) {
    return buildSkippedJobSummary(job, traceId, "pr_not_open", dependencies.now);
  }
  let pendingCheckRunId: number | undefined;
  if (dependencies.deliveryMode === "github") {
    try {
      if (job.check_run_id !== undefined) {
        await updateCheckRunFn({
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          checkRunId: job.check_run_id,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          status: "in_progress",
          output: { title: "Review in progress", summary: "Analysing pull request..." },
          apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
          userAgent: githubFetchOptions.githubUserAgent,
          requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
          traceId,
        });
        pendingCheckRunId = job.check_run_id;
        infoLogger(
          `[worker] check_run_in_progress trace=${traceId} job=${job.job_id} checkRunId=${job.check_run_id}`,
        );
      } else {
        const pendingCheckRun = await createCheckRunFn({
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          headSha: job.head_sha,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          name: "Mergewise",
          status: "in_progress",
          output: { title: "Review in progress", summary: "Analysing pull request..." },
          apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
          userAgent: githubFetchOptions.githubUserAgent,
          requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
          traceId,
        });
        pendingCheckRunId = pendingCheckRun.id;
        infoLogger(
          `[worker] check_run_in_progress trace=${traceId} job=${job.job_id} checkRunId=${pendingCheckRun.id}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorLogger(
        `[worker] failed to create in-progress check run trace=${traceId} job=${job.job_id}: ${detail}`,
      );
    }
  }

  const hasCodebaseAwareRules = selectedRules.some((rule) => rule.kind === "codebase-aware");
  const codebaseContext: CodebaseContext | undefined = hasCodebaseAwareRules
    ? {
        symbols: [],
        conventions: new Map<string, string>(),
        readFile: async (relativePath: string) => {
          try {
            return await fetchFileContent({
              owner: githubAnalysisContext.owner,
              repository: githubAnalysisContext.repository,
              path: relativePath,
              ref: job.head_sha,
              installationAccessToken: githubAnalysisContext.installationAccessToken,
              apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
              userAgent: githubFetchOptions.githubUserAgent,
              requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
              traceId,
            });
          } catch (caughtError) {
            const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
            errorLogger(
              `[worker] readFile failed trace=${traceId} job=${job.job_id} file=${relativePath} ref=${job.head_sha} repo=${githubAnalysisContext.owner}/${githubAnalysisContext.repository}: ${detail}`,
            );
            throw new Error(
              `Failed to read ${relativePath} at ${job.head_sha} for ${githubAnalysisContext.owner}/${githubAnalysisContext.repository}`,
              { cause: caughtError },
            );
          }
        },
      }
    : undefined;

  const executionResult = await executeRulesFn({
    context: githubAnalysisContext.analysisContext,
    rules: selectedRules,
    codebaseContext,
    onRuleExecutionError: (rule, error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(
        `[worker] rule failure trace=${traceId} job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
      );
    },
  });
  const gatedExecutionResult = applyFindingGates(executionResult, mergewiseConfigResolved);
  const delivery = prepareFindingDelivery(executionResult.findings, findingDeliveryOptions);

  let postedCommentCount = 0;
  if (dependencies.deliveryMode === "github") {
    const listSummaryFn =
      dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
    const listReviewThreadsFn =
      dependencies.listPullRequestReviewThreadsFn ?? listPullRequestReviewThreads;
    const existingCommentState = await loadExistingDedupeKeys(
      {
        owner: githubAnalysisContext.owner,
        repository: githubAnalysisContext.repository,
        pullRequestNumber: job.pr_number,
        installationAccessToken: githubAnalysisContext.installationAccessToken,
        apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
        userAgent: githubFetchOptions.githubUserAgent,
        requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
        traceId,
      },
      {
        listPullRequestSummaryCommentsFn: listSummaryFn,
        listPullRequestReviewThreadsFn: listReviewThreadsFn,
      },
    );

    const feedbackSummary = collectCommentFeedback(existingCommentState.allComments);
    for (const record of feedbackSummary.records) {
      infoLogger(
        `[worker] comment_feedback trace=${traceId} job=${job.job_id}` +
          ` findingId=${record.findingId} ruleId=${record.ruleId}` +
          ` category=${record.category} confidence=${record.confidence}` +
          ` thumbsUp=${record.thumbsUp} thumbsDown=${record.thumbsDown}` +
          ` reactions=${record.thumbsUp + record.thumbsDown + record.otherReactions}`,
      );
    }
    logFeedbackSummary(feedbackSummary, traceId, job.job_id, infoLogger);

    const newDedupeKeys = new Set(delivery.comments.map((comment) => comment.dedupeKey));
    const resolveResult = await resolveOutdatedComments(
      existingCommentState,
      newDedupeKeys,
      {
        installationAccessToken: githubAnalysisContext.installationAccessToken,
        traceId,
        githubFetchOptions,
      },
      {
        resolveReviewThreadFn: dependencies.resolveReviewThreadFn,
        logInfo: infoLogger,
        logError: errorLogger,
      },
    );

    for (const key of resolveResult.resolvedOutdatedDedupeKeys) {
      existingCommentState.dedupeKeys.delete(key);
    }

    const prSummaryBody = buildPrSummaryComment({
      filePaths: githubAnalysisContext.analysisContext.diffs.map((diff) => diff.filePath),
      findings: gatedExecutionResult.findings,
      repositoryFullName: job.repo_full_name,
      headSha: job.head_sha,
      rulesRan: gatedExecutionResult.summary.totalRules,
      rulesPassed: gatedExecutionResult.summary.successfulRules,
    });
    try {
      await upsertPrSummaryComment(
        {
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          pullRequestNumber: job.pr_number,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          body: prSummaryBody,
          traceId,
          githubFetchOptions,
        },
        {
          listPullRequestSummaryCommentsFn: listSummaryFn,
          postPullRequestSummaryCommentFn: dependencies.postPullRequestSummaryCommentFn,
          updateIssueCommentFn: dependencies.updateIssueCommentFn,
          logInfo: infoLogger,
          logError: errorLogger,
        },
      );
    } catch (summaryError) {
      const detail = summaryError instanceof Error ? summaryError.message : String(summaryError);
      errorLogger(
        `[worker] summary_comment_failed trace=${traceId} job=${job.job_id}: ${detail}`,
      );
    }

    const fileCount = githubAnalysisContext.analysisContext.diffs.length;
    const summaryBody =
      `${fileCount} file${fileCount === 1 ? "" : "s"} reviewed, ` +
      `${delivery.comments.length} comment${delivery.comments.length === 1 ? "" : "s"}`;
    const postingResult = await postPreparedFindingComments(
      {
        owner: githubAnalysisContext.owner,
        repository: githubAnalysisContext.repository,
        pullRequestNumber: job.pr_number,
        pullRequestHeadSha: job.head_sha,
        installationAccessToken: githubAnalysisContext.installationAccessToken,
        traceId,
        githubFetchOptions,
        comments: delivery.comments,
        summaryBody,
      },
      {
        createPullRequestReviewFn: dependencies.createPullRequestReviewFn,
        existingDedupeKeys: existingCommentState.dedupeKeys,
      },
    );
    postedCommentCount = postingResult.postedCount;
  }

  const checkOutput = buildWorkerCheckOutput(gatedExecutionResult, delivery, postedCommentCount, {
    repositoryFullName: job.repo_full_name,
    headSha: job.head_sha,
  });

  const summary = buildJobSummary(
    job,
    key,
    gatedExecutionResult,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );
  infoLogger(
    `[worker] summary trace=${summary.traceId} job=${summary.jobId} findings=${summary.totalFindings} rules_ok=${summary.successfulRules}/${summary.totalRules}`,
  );
  infoLogger(
    `[worker] check_output trace=${summary.traceId} job=${summary.jobId} payload=${JSON.stringify(checkOutput)}`,
  );

  if (dependencies.deliveryMode === "github") {
    try {
      if (pendingCheckRunId !== undefined) {
        await updateCheckRunFn({
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          checkRunId: pendingCheckRunId,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          status: "completed",
          conclusion: "success",
          output: checkOutput,
          apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
          userAgent: githubFetchOptions.githubUserAgent,
          requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
          traceId,
        });
      } else {
        await createCheckRunFn({
          owner: githubAnalysisContext.owner,
          repository: githubAnalysisContext.repository,
          headSha: job.head_sha,
          installationAccessToken: githubAnalysisContext.installationAccessToken,
          name: "Mergewise",
          conclusion: "success",
          output: checkOutput,
          apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
          userAgent: githubFetchOptions.githubUserAgent,
          requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
          traceId,
        });
      }
      infoLogger(
        `[worker] check_run_completed trace=${traceId} job=${job.job_id}`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errorLogger(
        `[worker] check_run_failed trace=${traceId} job=${job.job_id}: ${detail}`,
      );
    }
  }

  return {
    ...summary,
    postedCommentCount,
    skippedByConfidence: delivery.skippedByConfidence,
    skippedByDeduplication: delivery.skippedByDeduplication,
    skippedByPolicy: delivery.skippedByPolicy,
    skippedByGrouping: delivery.skippedByGrouping,
    skippedByCap: delivery.skippedByCap,
    checkOutput,
  };
}

export async function buildAnalysisContextFromGitHub(
  job: AnalyzePullRequestJob,
  githubFetchOptions: WorkerGitHubFetchOptions,
  dependencies: {
    readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
    readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
    readonly fetchPullRequestFilesWithRetryFn?: typeof fetchPullRequestFilesWithRetry;
    readonly logWarn?: (message: string) => void;
    readonly logInfo?: (message: string) => void;
    readonly logError?: (message: string) => void;
  },
): Promise<{
  readonly analysisContext: AnalysisContext;
  readonly owner: string;
  readonly repository: string;
  readonly installationAccessToken: string;
}> {
  if (job.installation_id === null) {
    throw new Error(
      `[worker] missing installation_id for ${job.repo_full_name}#${job.pr_number}`,
    );
  }

  const repositoryCoordinates = parseRepositoryFullName(job.repo_full_name);
  if (!repositoryCoordinates) {
    throw new Error(`[worker] invalid repo_full_name=${job.repo_full_name}`);
  }

  const appCredentials = loadGitHubAppCredentials();

  const createGitHubAppJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
  const exchangeInstallationAccessTokenFn =
    dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;
  const fetchPullRequestFilesWithRetryFn =
    dependencies.fetchPullRequestFilesWithRetryFn ?? fetchPullRequestFilesWithRetry;

  const appJwt = createGitHubAppJwtFn(appCredentials);
  const installationAccessToken = await exchangeInstallationAccessTokenFn(
    appJwt,
    job.installation_id,
    {
      apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
      userAgent: githubFetchOptions.githubUserAgent,
      requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
    },
  );

  const fetchedFiles = await fetchPullRequestFilesWithRetryFn(
    {
      owner: repositoryCoordinates.owner,
      repository: repositoryCoordinates.repository,
      pullRequestNumber: job.pr_number,
      installationAccessToken: installationAccessToken.token,
      apiBaseUrl: githubFetchOptions.githubApiBaseUrl,
      userAgent: githubFetchOptions.githubUserAgent,
      requestTimeoutMs: githubFetchOptions.githubRequestTimeoutMs,
    },
    githubFetchOptions.githubFetchRetries,
    githubFetchOptions.githubRetryDelayMs,
    {
      fetchPullRequestFiles,
      sleep: defaultSleep,
      logWarn: dependencies.logWarn,
      logInfo: dependencies.logInfo,
      logError: dependencies.logError,
    },
  );

  const mappedDiffs = mapGitHubPullRequestFilesToDiffs(fetchedFiles);
  return {
    analysisContext: buildAnalysisContext(job, mappedDiffs),
    owner: repositoryCoordinates.owner,
    repository: repositoryCoordinates.repository,
    installationAccessToken: installationAccessToken.token,
  };
}

export function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function isRetryablePullRequestFileFetchError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return error.status === 429 || error.status >= 500;
  }

  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return false;
}
