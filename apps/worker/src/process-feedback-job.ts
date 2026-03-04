import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  listPullRequestSummaryComments,
  listPullRequestReviewThreadsWithReplies,
} from "@mergewise/github-client";
import type {
  GitHubIssueComment,
  ListPullRequestCommentsOptions,
  ListPullRequestReviewThreadsOptions,
  ReviewThreadWithReplies,
} from "@mergewise/github-client";
import type { FeedbackStore, FeedbackRecord } from "@mergewise/feedback-store";
import type { CollectFeedbackJob } from "@mergewise/shared-types";

import { loadGitHubAppCredentials } from "./github-auth";
import { parseRepositoryFullName } from "./job-utils";
import { collectCommentFeedback, logFeedbackSummary, type CommentFeedbackSummary } from "./pr-comments";
import { extractInstructionsFromThreads } from "./extract-instructions";
import type { WorkerGitHubFetchOptions } from "./config";

function noop(): void {
  /* intentional no-op */
}

/**
 * Dependencies for feedback job processing, injectable for testing.
 */
export interface FeedbackJobDependencies {
  readonly feedbackStore?: FeedbackStore;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  readonly listPullRequestSummaryCommentsFn?: (
    options: ListPullRequestCommentsOptions,
  ) => Promise<GitHubIssueComment[]>;
  readonly listPullRequestReviewThreadsWithRepliesFn?: (
    options: ListPullRequestReviewThreadsOptions,
  ) => Promise<ReviewThreadWithReplies[]>;
  readonly logInfo?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

interface FeedbackJobContext {
  readonly job: CollectFeedbackJob;
  readonly traceId: string;
  readonly feedbackStore: FeedbackStore;
  readonly infoLogger: (message: string) => void;
  readonly errorLogger: (message: string) => void;
}

function mapToFeedbackRecords(
  summary: CommentFeedbackSummary,
  job: CollectFeedbackJob,
  traceId: string,
): FeedbackRecord[] {
  const now = new Date().toISOString();
  return summary.records.map((record) => ({
    findingId: record.findingId,
    ruleId: record.ruleId,
    category: record.category,
    confidence: record.confidence,
    thumbsUp: record.thumbsUp,
    thumbsDown: record.thumbsDown,
    otherReactions: record.otherReactions,
    repoFullName: job.repo_full_name,
    prNumber: job.pr_number,
    traceId,
    recordedAt: now,
  }));
}

function persistReactionFeedback(
  ctx: FeedbackJobContext,
  feedbackSummary: CommentFeedbackSummary,
): void {
  logFeedbackSummary(feedbackSummary, ctx.traceId, ctx.job.job_id, ctx.infoLogger);

  if (feedbackSummary.records.length === 0) {
    return;
  }

  const feedbackRecords = mapToFeedbackRecords(feedbackSummary, ctx.job, ctx.traceId);
  try {
    ctx.feedbackStore.saveFeedback(feedbackRecords);
    ctx.infoLogger(`[worker] feedback_persisted trace=${ctx.traceId} records=${feedbackRecords.length}`);
  } catch (persistError) {
    const detail = persistError instanceof Error ? persistError.message : String(persistError);
    ctx.errorLogger(`[worker] feedback_persist_failed trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`);
  }
}

function persistInstructions(
  ctx: FeedbackJobContext,
  threadReplies: readonly ReviewThreadWithReplies[],
): number {
  const instructions = extractInstructionsFromThreads(threadReplies, ctx.job.repo_full_name, ctx.job.pr_number);

  if (instructions.length === 0) {
    return 0;
  }

  try {
    ctx.feedbackStore.saveInstructions(instructions);
    ctx.infoLogger(`[worker] instructions_persisted trace=${ctx.traceId} count=${instructions.length}`);
  } catch (persistError) {
    const detail = persistError instanceof Error ? persistError.message : String(persistError);
    ctx.errorLogger(`[worker] instructions_persist_failed trace=${ctx.traceId} job=${ctx.job.job_id}: ${detail}`);
  }

  return instructions.length;
}

/**
 * Processes a collect-feedback job: fetches PR comments and thread replies,
 * extracts reaction feedback and conversational instructions, and persists both.
 *
 * @param job - Feedback collection job payload.
 * @param dependencies - Processing dependencies.
 */
export async function processCollectFeedbackJob(
  job: CollectFeedbackJob,
  dependencies: FeedbackJobDependencies,
): Promise<void> {
  const infoLogger = dependencies.logInfo ?? noop;
  const errorLogger = dependencies.logError ?? noop;
  const traceId = job.trace_id ?? job.job_id;

  infoLogger(`[worker] processing feedback job=${job.job_id} trace=${traceId} repo=${job.repo_full_name} pr=${job.pr_number}`);

  if (!dependencies.feedbackStore) {
    infoLogger(`[worker] feedback_store_unavailable trace=${traceId} — skipping feedback collection`);
    return;
  }

  const parsed = parseRepositoryFullName(job.repo_full_name);
  if (!parsed) {
    errorLogger(`[worker] invalid repo_full_name=${job.repo_full_name} trace=${traceId}`);
    return;
  }

  if (job.installation_id === null) {
    errorLogger(`[worker] feedback_missing_installation trace=${traceId} job=${job.job_id}`);
    return;
  }

  const createJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
  const exchangeTokenFn = dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;

  let installationAccessToken: string;
  try {
    const appCredentials = loadGitHubAppCredentials();
    const appJwt = createJwtFn(appCredentials);
    const tokenResult = await exchangeTokenFn(appJwt, job.installation_id, {
      apiBaseUrl: dependencies.githubFetchOptions.githubApiBaseUrl,
      userAgent: dependencies.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: dependencies.githubFetchOptions.githubRequestTimeoutMs,
    });
    installationAccessToken = tokenResult.token;
  } catch (authError) {
    const detail = authError instanceof Error ? authError.message : String(authError);
    errorLogger(`[worker] feedback_auth_failed trace=${traceId} job=${job.job_id}: ${detail}`);
    return;
  }

  const commonOptions = {
    owner: parsed.owner,
    repository: parsed.repository,
    pullRequestNumber: job.pr_number,
    installationAccessToken,
    apiBaseUrl: dependencies.githubFetchOptions.githubApiBaseUrl,
    userAgent: dependencies.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: dependencies.githubFetchOptions.githubRequestTimeoutMs,
    traceId,
  };

  const listSummaryFn = dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
  const listThreadsFn = dependencies.listPullRequestReviewThreadsWithRepliesFn ?? listPullRequestReviewThreadsWithReplies;

  let summaryComments: GitHubIssueComment[];
  let threadReplies: ReviewThreadWithReplies[];
  try {
    [summaryComments, threadReplies] = await Promise.all([listSummaryFn(commonOptions), listThreadsFn(commonOptions)]);
  } catch (fetchError) {
    const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
    errorLogger(`[worker] feedback_fetch_failed trace=${traceId} job=${job.job_id}: ${detail}`);
    return;
  }

  const ctx: FeedbackJobContext = { job, traceId, feedbackStore: dependencies.feedbackStore, infoLogger, errorLogger };
  const feedbackSummary = collectCommentFeedback(summaryComments);
  persistReactionFeedback(ctx, feedbackSummary);
  const instructionCount = persistInstructions(ctx, threadReplies);

  infoLogger(`[worker] feedback_job_complete trace=${traceId} job=${job.job_id} reactions=${feedbackSummary.records.length} instructions=${instructionCount}`);
}
