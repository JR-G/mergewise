import {
  listPullRequestReviewThreads,
  listPullRequestSummaryComments,
  type GitHubIssueComment,
  type ListPullRequestCommentsOptions,
} from "@mergewise/github-client";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";
import type { WorkerGitHubFetchOptions } from "./config";
import type { prepareFindingDelivery } from "./delivery";
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
import type { GitHubAnalysisContextResult } from "./github-fetch";
import type { WorkerProcessingDependencies, ResolvedLoggers } from "./process-job-types";

export interface DeliveryContext {
  readonly job: AnalyzePullRequestJob;
  readonly githubAnalysisContext: GitHubAnalysisContextResult;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly traceId: string;
  readonly loggers: ResolvedLoggers;
  readonly gatedExecutionResult: RuleExecutionResult;
  readonly delivery: ReturnType<typeof prepareFindingDelivery>;
}

/**
 * Delivers findings, resolves outdated comments, and upserts summary on GitHub.
 */
export async function deliverFindingsToGitHub(
  ctx: DeliveryContext,
  dependencies: WorkerProcessingDependencies,
): Promise<number> {
  const listSummaryFn =
    dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
  const listReviewThreadsFn =
    dependencies.listPullRequestReviewThreadsFn ?? listPullRequestReviewThreads;

  const existingCommentState = await loadExistingDedupeKeys(
    {
      owner: ctx.githubAnalysisContext.owner,
      repository: ctx.githubAnalysisContext.repository,
      pullRequestNumber: ctx.job.pr_number,
      installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
      apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
      userAgent: ctx.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
      traceId: ctx.traceId,
    },
    {
      listPullRequestSummaryCommentsFn: listSummaryFn,
      listPullRequestReviewThreadsFn: listReviewThreadsFn,
    },
  );

  logCommentFeedback(ctx, existingCommentState.allComments);

  const newDedupeKeys = new Set(ctx.delivery.comments.map((comment) => comment.dedupeKey));
  const resolveResult = await resolveOutdatedComments(
    existingCommentState,
    newDedupeKeys,
    {
      installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
      traceId: ctx.traceId,
      githubFetchOptions: ctx.githubFetchOptions,
    },
    {
      resolveReviewThreadFn: dependencies.resolveReviewThreadFn,
      logInfo: ctx.loggers.infoLogger,
      logError: ctx.loggers.errorLogger,
    },
  );

  for (const resolvedKey of resolveResult.resolvedOutdatedDedupeKeys) {
    existingCommentState.dedupeKeys.delete(resolvedKey);
  }

  await upsertSummaryComment(ctx, listSummaryFn, dependencies);

  const postingResult = await postPreparedFindingComments(
    {
      owner: ctx.githubAnalysisContext.owner,
      repository: ctx.githubAnalysisContext.repository,
      pullRequestNumber: ctx.job.pr_number,
      pullRequestHeadSha: ctx.job.head_sha,
      installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
      traceId: ctx.traceId,
      githubFetchOptions: ctx.githubFetchOptions,
      comments: ctx.delivery.comments,
      summaryBody: buildDeliverySummaryBody(ctx),
    },
    {
      createPullRequestReviewFn: dependencies.createPullRequestReviewFn,
      existingDedupeKeys: existingCommentState.dedupeKeys,
    },
  );

  return postingResult.postedCount;
}

function logCommentFeedback(
  ctx: DeliveryContext,
  allComments: Parameters<typeof collectCommentFeedback>[0],
): void {
  const feedbackSummary = collectCommentFeedback(allComments);
  for (const record of feedbackSummary.records) {
    ctx.loggers.infoLogger(
      `[worker] comment_feedback trace=${ctx.traceId} job=${ctx.job.job_id}` +
        ` findingId=${record.findingId} ruleId=${record.ruleId}` +
        ` category=${record.category} confidence=${record.confidence}` +
        ` thumbsUp=${record.thumbsUp} thumbsDown=${record.thumbsDown}` +
        ` reactions=${record.thumbsUp + record.thumbsDown + record.otherReactions}`,
    );
  }
  logFeedbackSummary(feedbackSummary, ctx.traceId, ctx.job.job_id, ctx.loggers.infoLogger);
}

function buildDeliverySummaryBody(ctx: DeliveryContext): string {
  const fileCount = ctx.githubAnalysisContext.analysisContext.diffs.length;
  return (
    `${fileCount} file${fileCount === 1 ? "" : "s"} reviewed, ` +
    `${ctx.delivery.comments.length} comment${ctx.delivery.comments.length === 1 ? "" : "s"}`
  );
}

async function upsertSummaryComment(
  ctx: DeliveryContext,
  listSummaryFn: (options: ListPullRequestCommentsOptions) => Promise<GitHubIssueComment[]>,
  dependencies: WorkerProcessingDependencies,
): Promise<void> {
  const prSummaryBody = buildPrSummaryComment({
    filePaths: ctx.githubAnalysisContext.analysisContext.diffs.map((diff) => diff.filePath),
    findings: ctx.gatedExecutionResult.findings,
    repositoryFullName: ctx.job.repo_full_name,
    headSha: ctx.job.head_sha,
    rulesRan: ctx.gatedExecutionResult.summary.totalRules,
    rulesPassed: ctx.gatedExecutionResult.summary.successfulRules,
    deliveryCounters: ctx.delivery,
  });

  try {
    await upsertPrSummaryComment(
      {
        owner: ctx.githubAnalysisContext.owner,
        repository: ctx.githubAnalysisContext.repository,
        pullRequestNumber: ctx.job.pr_number,
        installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
        body: prSummaryBody,
        traceId: ctx.traceId,
        githubFetchOptions: ctx.githubFetchOptions,
      },
      {
        listPullRequestSummaryCommentsFn: listSummaryFn,
        postPullRequestSummaryCommentFn: dependencies.postPullRequestSummaryCommentFn,
        updateIssueCommentFn: dependencies.updateIssueCommentFn,
        logInfo: ctx.loggers.infoLogger,
        logError: ctx.loggers.errorLogger,
      },
    );
  } catch (summaryError) {
    const detail = summaryError instanceof Error ? summaryError.message : String(summaryError);
    ctx.loggers.errorLogger(
      `[worker] summary_comment_failed trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`,
    );
  }
}
