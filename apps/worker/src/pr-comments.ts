import {
  listPullRequestReviewThreads,
  listPullRequestSummaryComments,
  createPullRequestReview,
  resolveReviewThread,
  type GitHubIssueComment,
  type GitHubPullRequestReview,
  type ListPullRequestCommentsOptions,
  type ListPullRequestReviewThreadsOptions,
  type CreatePullRequestReviewOptions,
  type ResolveReviewThreadOptions,
  type ResolveReviewThreadResult,
  type ReviewThread,
  type PullRequestReviewComment,
  type GitHubReactionCounts,
} from "@mergewise/github-client";
import { MERGEWISE_META_REGEX } from "./comment-formatter";
import type { WorkerGitHubFetchOptions } from "./config";
import type { PreparedFindingComment } from "./delivery";

/**
 * Aggregated comment state from existing PR comments, used for deduplication and minimisation.
 */
export interface ExistingCommentState {
  /**
   * Set of dedupe keys found in existing PR comments.
   */
  readonly dedupeKeys: Set<string>;
  /**
   * Mapping from dedupe key to the review thread's GraphQL node ID for resolution.
   */
  readonly dedupeKeyToThreadId: ReadonlyMap<string, string>;
  /**
   * All fetched comments (summary + inline review thread) for downstream feedback extraction.
   * Reactions are only available on summary comments; review thread entries have no reactions.
   */
  readonly allComments: readonly { readonly body: string; readonly reactions?: GitHubReactionCounts }[];
  /**
   * Dedupe keys belonging to inline comments that GitHub has marked as outdated
   * (the anchored code changed since the comment was posted).
   */
  readonly outdatedDedupeKeys: ReadonlySet<string>;
}

/**
 * Redacted request payload retained for posting telemetry.
 */
export interface PostedCommentRequestOptions {
  /** Repository owner. */
  readonly owner: string;
  /** Repository name. */
  readonly repository: string;
  /** Pull request number. */
  readonly pullRequestNumber: number;
  /** Redacted installation access token marker. */
  readonly installationAccessToken: string;
  /** Markdown body sent to GitHub. */
  readonly body: string;
  /** GitHub API base URL. */
  readonly apiBaseUrl?: string;
  /** GitHub API user agent. */
  readonly userAgent?: string;
  /** Request timeout in milliseconds. */
  readonly requestTimeoutMs?: number;
  /** Optional end-to-end trace identifier for observability. */
  readonly traceId?: string;
  /** Inline path for review comments when available. */
  readonly path?: string;
  /** Inline line for review comments when available. */
  readonly line?: number;
  /** Commit SHA used for inline anchors when available. */
  readonly commitId?: string;
  /** Posted mode for diagnostics. */
  readonly mode?: "inline" | "summary";
}

/**
 * Metadata for one successfully posted finding comment.
 */
export interface PostedFindingCommentSuccess {
  /**
   * Index of the prepared comment in the input list.
   */
  readonly index: number;
  /**
   * Prepared comment that was posted.
   */
  readonly preparedComment: PreparedFindingComment;
  /**
   * Request payload used to post this comment.
   */
  readonly requestOptions: PostedCommentRequestOptions;
  /**
   * Created GitHub issue comment response, or `null` for batch review posts
   * where individual comment metadata is unavailable.
   */
  readonly createdComment: {
    readonly id: number;
    readonly html_url: string;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
  } | null;
}

/**
 * Metadata for one failed finding comment post attempt.
 */
export interface PostedFindingCommentFailure {
  /**
   * Index of the prepared comment in the input list.
   */
  readonly index: number;
  /**
   * Prepared comment that failed to post.
   */
  readonly preparedComment: PreparedFindingComment;
  /**
   * Request payload used for the failed post attempt.
   */
  readonly requestOptions: PostedCommentRequestOptions;
  /**
   * Error message for the failed post attempt.
   */
  readonly errorMessage: string;
}

/**
 * Metadata for one finding skipped due to an existing dedupe key on the PR.
 */
export interface PostedFindingCommentSkipped {
  /**
   * Index of the prepared comment in the input list.
   */
  readonly index: number;
  /**
   * Prepared comment that was skipped.
   */
  readonly preparedComment: PreparedFindingComment;
  /**
   * Skip reason identifier.
   */
  readonly reason: "existing_dedupe_key";
}

/**
 * Result summary for prepared finding comment posting.
 */
export interface PostPreparedFindingCommentsResult {
  /**
   * Number of successful comment posts.
   */
  readonly postedCount: number;
  /**
   * Successful post entries in call order.
   */
  readonly successes: readonly PostedFindingCommentSuccess[];
  /**
   * Failed post entries in call order.
   */
  readonly failures: readonly PostedFindingCommentFailure[];
  /**
   * Skipped comment entries in call order.
   */
  readonly skipped: readonly PostedFindingCommentSkipped[];
}

/**
 * Structured feedback record extracted from a single Mergewise comment's reactions.
 */
export interface CommentFeedbackRecord {
  readonly findingId: string;
  readonly ruleId: string;
  readonly category: string;
  readonly confidence: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly otherReactions: number;
}

/**
 * Aggregate feedback summary across all Mergewise comments on a PR.
 */
export interface CommentFeedbackSummary {
  readonly totalComments: number;
  readonly withReactions: number;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly records: readonly CommentFeedbackRecord[];
}

interface PostFindingCommentsOptions {
  readonly owner: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestHeadSha: string;
  readonly installationAccessToken: string;
  readonly traceId: string;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly comments: readonly PreparedFindingComment[];
  readonly summaryBody: string;
}

interface PostFindingCommentsDependencies {
  readonly logError?: (message: string) => void;
  readonly listPullRequestSummaryCommentsFn?: (
    options: ListPullRequestCommentsOptions,
  ) => Promise<GitHubIssueComment[]>;
  readonly listPullRequestReviewThreadsFn?: (
    options: ListPullRequestReviewThreadsOptions,
  ) => Promise<ReviewThread[]>;
  readonly createPullRequestReviewFn?: (
    options: CreatePullRequestReviewOptions,
  ) => Promise<GitHubPullRequestReview>;
  readonly existingDedupeKeys?: Set<string>;
}

function filterByExistingDedupeKeys(
  comments: readonly PreparedFindingComment[],
  resolvedDedupeKeys: Set<string>,
): { skipped: PostedFindingCommentSkipped[]; filtered: { index: number; preparedComment: PreparedFindingComment }[] } {
  const skipped: PostedFindingCommentSkipped[] = [];
  const filtered: { index: number; preparedComment: PreparedFindingComment }[] = [];
  for (const [index, preparedComment] of comments.entries()) {
    if (resolvedDedupeKeys.has(preparedComment.dedupeKey)) {
      skipped.push({ index, preparedComment, reason: "existing_dedupe_key" });
      continue;
    }
    filtered.push({ index, preparedComment });
  }
  return { skipped, filtered };
}

function buildCommentRequestOptions(
  options: PostFindingCommentsOptions,
  preparedComment: PreparedFindingComment,
): PostedCommentRequestOptions {
  return {
    owner: options.owner,
    repository: options.repository,
    pullRequestNumber: options.pullRequestNumber,
    installationAccessToken: "[REDACTED]",
    body: preparedComment.body,
    path: preparedComment.finding.filePath,
    line: preparedComment.finding.line,
    commitId: options.pullRequestHeadSha,
    mode: "inline" as const,
    apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
    userAgent: options.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    traceId: options.traceId,
  };
}

async function resolveDedupeKeysForPosting(
  options: PostFindingCommentsOptions,
  dependencies: PostFindingCommentsDependencies,
): Promise<Set<string>> {
  if (dependencies.existingDedupeKeys) {
    return dependencies.existingDedupeKeys;
  }

  const listSummaryFn =
    dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
  const listThreadsFn =
    dependencies.listPullRequestReviewThreadsFn ?? listPullRequestReviewThreads;
  const commentState = await loadExistingDedupeKeys(
    {
      owner: options.owner,
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      installationAccessToken: options.installationAccessToken,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    },
    { listPullRequestSummaryCommentsFn: listSummaryFn, listPullRequestReviewThreadsFn: listThreadsFn },
  );
  return commentState.dedupeKeys;
}

/**
 * Posts prepared finding comments and a summary as a single batch pull request review.
 *
 * @param options - Repository coordinates, token, prepared comments, and summary body.
 * @param dependencies - API posting dependency override.
 * @returns Structured summary of successful and failed post attempts.
 */
export async function postPreparedFindingComments(
  options: PostFindingCommentsOptions,
  dependencies: PostFindingCommentsDependencies = {},
): Promise<PostPreparedFindingCommentsResult> {
  const errorLogger = dependencies.logError ?? console.error;
  const createPullRequestReviewFn =
    dependencies.createPullRequestReviewFn ?? createPullRequestReview;

  const resolvedDedupeKeys = await resolveDedupeKeysForPosting(options, dependencies);
  const { skipped, filtered } = filterByExistingDedupeKeys(options.comments, resolvedDedupeKeys);
  const reviewComments: PullRequestReviewComment[] = filtered.map(
    ({ preparedComment }) => ({
      path: preparedComment.finding.filePath,
      line: preparedComment.finding.line,
      body: preparedComment.body,
    }),
  );

  try {
    await createPullRequestReviewFn({
      owner: options.owner,
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      installationAccessToken: options.installationAccessToken,
      commitId: options.pullRequestHeadSha,
      body: options.summaryBody,
      event: "COMMENT",
      comments: reviewComments,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    });

    const successes: PostedFindingCommentSuccess[] = filtered.map(
      ({ index, preparedComment }) => ({
        index,
        preparedComment,
        requestOptions: buildCommentRequestOptions(options, preparedComment),
        createdComment: null,
      }),
    );

    return { postedCount: successes.length, successes, failures: [], skipped };
  } catch (reviewError) {
    const errorMessage = reviewError instanceof Error ? reviewError.message : String(reviewError);
    const errorDetail = reviewError instanceof Error
      ? reviewError.stack ?? reviewError.message
      : String(reviewError);
    errorLogger(
      "[worker] batch review post failed" +
        " pr=" + String(options.pullRequestNumber) +
        " commentCount=" + String(filtered.length) +
        " error=" + errorDetail,
    );

    const failures: PostedFindingCommentFailure[] = filtered.map(
      ({ index, preparedComment }) => ({
        index,
        preparedComment,
        requestOptions: buildCommentRequestOptions(options, preparedComment),
        errorMessage,
      }),
    );

    return { postedCount: 0, successes: [], failures, skipped };
  }
}

/**
 * Resolves review threads whose dedupe keys are absent from the new set or
 * whose anchored code has been changed (GitHub-outdated).
 *
 * @param existingCommentState - Existing comment state with dedupe key to thread ID mapping.
 * @param newDedupeKeys - Dedupe keys from the current analysis run.
 * @param options - Authentication and API options.
 * @param dependencies - Test overrides.
 * @returns Count of resolved and failed threads.
 */
export async function resolveOutdatedComments(
  existingCommentState: ExistingCommentState,
  newDedupeKeys: ReadonlySet<string>,
  options: {
    readonly installationAccessToken: string;
    readonly traceId: string;
    readonly githubFetchOptions: WorkerGitHubFetchOptions;
  },
  dependencies?: {
    readonly resolveReviewThreadFn?: (
      opts: ResolveReviewThreadOptions,
    ) => Promise<ResolveReviewThreadResult>;
    readonly logInfo?: (message: string) => void;
    readonly logError?: (message: string) => void;
  },
): Promise<{ resolvedCount: number; failedCount: number; resolvedOutdatedDedupeKeys: Set<string> }> {
  const resolveReviewThreadFn = dependencies?.resolveReviewThreadFn ?? resolveReviewThread;
  const infoLogger = dependencies?.logInfo ?? console.log;
  const errorLogger = dependencies?.logError ?? console.error;

  let resolvedCount = 0;
  let failedCount = 0;
  const resolvedOutdatedDedupeKeys = new Set<string>();

  for (const [dedupeKey, threadId] of existingCommentState.dedupeKeyToThreadId) {
    const isGitHubOutdated = existingCommentState.outdatedDedupeKeys.has(dedupeKey);
    if (newDedupeKeys.has(dedupeKey) && !isGitHubOutdated) {
      continue;
    }

    try {
      const result = await resolveReviewThreadFn({
        threadId,
        installationAccessToken: options.installationAccessToken,
        apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
        userAgent: options.githubFetchOptions.githubUserAgent,
        requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
        traceId: options.traceId,
      });
      if (result.isResolved) {
        resolvedCount += 1;
      }
      if (result.isResolved && isGitHubOutdated && newDedupeKeys.has(dedupeKey)) {
        resolvedOutdatedDedupeKeys.add(dedupeKey);
      }
    } catch (error) {
      failedCount += 1;
      const detail = error instanceof Error ? error.message : String(error);
      errorLogger(
        `[worker] failed to resolve outdated thread trace=${options.traceId} threadId=${threadId} dedupeKey=${dedupeKey}: ${detail}`,
      );
    }
  }

  if (resolvedCount > 0) {
    infoLogger(
      `[worker] resolved_outdated_threads trace=${options.traceId} resolved=${resolvedCount} failed=${failedCount}`,
    );
  }

  return { resolvedCount, failedCount, resolvedOutdatedDedupeKeys };
}

interface DedupeKeyAccumulator {
  readonly dedupeKeys: Set<string>;
  readonly dedupeKeyToThreadId: Map<string, string>;
  readonly allComments: { body: string; reactions?: GitHubReactionCounts }[];
  readonly outdatedDedupeKeys: Set<string>;
}

async function loadSummaryCommentDedupeKeys(
  options: ListPullRequestCommentsOptions,
  listFn: (options: ListPullRequestCommentsOptions) => Promise<GitHubIssueComment[]>,
  accumulator: DedupeKeyAccumulator,
): Promise<void> {
  try {
    const summaryComments = await listFn(options);
    for (const comment of summaryComments) {
      const dedupeKey = extractDedupeKeyFromCommentBody(comment.body);
      if (dedupeKey) {
        accumulator.dedupeKeys.add(dedupeKey);
      }
      accumulator.allComments.push({ body: comment.body, reactions: comment.reactions });
    }
  } catch (caughtError) {
    const errorDetail = caughtError instanceof Error
      ? caughtError.stack ?? caughtError.message
      : String(caughtError);
    console.error(
      `[worker] failed to list summary comments for dedupe owner=${options.owner} repo=${options.repository} pr=${options.pullRequestNumber} error=${errorDetail}`,
    );
  }
}

async function loadReviewThreadDedupeKeys(
  options: ListPullRequestCommentsOptions,
  listFn: (options: ListPullRequestReviewThreadsOptions) => Promise<ReviewThread[]>,
  accumulator: DedupeKeyAccumulator,
): Promise<void> {
  try {
    const reviewThreads = await listFn({
      owner: options.owner,
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      installationAccessToken: options.installationAccessToken,
      apiBaseUrl: options.apiBaseUrl,
      userAgent: options.userAgent,
      requestTimeoutMs: options.requestTimeoutMs,
      traceId: options.traceId,
    });
    for (const thread of reviewThreads) {
      accumulator.allComments.push({ body: thread.firstCommentBody });
      if (thread.isResolved) {
        continue;
      }
      const dedupeKey = extractDedupeKeyFromCommentBody(thread.firstCommentBody);
      if (!dedupeKey) {
        continue;
      }
      accumulator.dedupeKeys.add(dedupeKey);
      accumulator.dedupeKeyToThreadId.set(dedupeKey, thread.id);
      if (thread.isOutdated) {
        accumulator.outdatedDedupeKeys.add(dedupeKey);
      }
    }
  } catch (caughtError) {
    const errorDetail = caughtError instanceof Error
      ? caughtError.stack ?? caughtError.message
      : String(caughtError);
    console.error(
      `[worker] failed to list review threads for dedupe owner=${options.owner} repo=${options.repository} pr=${options.pullRequestNumber} error=${errorDetail}`,
    );
  }
}

/**
 * Populates dedupe keys by fetching existing summary comments and review threads from a PR.
 *
 * @param options - GitHub API coordinates and authentication for the target PR.
 * @param dependencies - Summary comment and review thread listing function overrides.
 * @returns Accumulated dedupe state including keys, thread IDs, and outdated markers.
 */
export async function loadExistingDedupeKeys(
  options: ListPullRequestCommentsOptions,
  dependencies: {
    readonly listPullRequestSummaryCommentsFn: (
      options: ListPullRequestCommentsOptions,
    ) => Promise<GitHubIssueComment[]>;
    readonly listPullRequestReviewThreadsFn: (
      options: ListPullRequestReviewThreadsOptions,
    ) => Promise<ReviewThread[]>;
  },
): Promise<ExistingCommentState> {
  const accumulator: DedupeKeyAccumulator = {
    dedupeKeys: new Set<string>(),
    dedupeKeyToThreadId: new Map<string, string>(),
    allComments: [],
    outdatedDedupeKeys: new Set<string>(),
  };

  await loadSummaryCommentDedupeKeys(
    options,
    dependencies.listPullRequestSummaryCommentsFn,
    accumulator,
  );
  await loadReviewThreadDedupeKeys(
    options,
    dependencies.listPullRequestReviewThreadsFn,
    accumulator,
  );

  return accumulator;
}

/**
 * Extracts the dedupe key from a comment body containing a `mergewise-meta` HTML marker.
 *
 * @param commentBody - Raw comment body, or `undefined` for missing bodies.
 * @returns The dedupe key string, or `null` when the marker is absent or empty.
 */
export function extractDedupeKeyFromCommentBody(commentBody: string | undefined): string | null {
  if (!commentBody) {
    return null;
  }

  const dedupeKeyMatch = /mergewise-meta[^>]*dedupeKey=([^\s>]+)/.exec(commentBody);
  if (!dedupeKeyMatch) {
    return null;
  }

  const dedupeKey = dedupeKeyMatch[1]?.trim() ?? "";
  return dedupeKey || null;
}

/**
 * Extracts feedback records from Mergewise comments that have reactions.
 *
 * @param comments - Issue or review comments with optional reaction counts.
 * @returns Feedback summary with per-comment records for reacted comments.
 */
export function collectCommentFeedback(
  comments: readonly { readonly body: string; readonly reactions?: GitHubReactionCounts }[],
): CommentFeedbackSummary {
  const records: CommentFeedbackRecord[] = [];
  let totalComments = 0;

  for (const comment of comments) {
    const meta = extractMergewiseMeta(comment.body);
    if (!meta) {
      continue;
    }

    totalComments += 1;

    if (!comment.reactions) {
      continue;
    }

    const { thumbsUp, thumbsDown, otherReactions } = sumReactions(comment.reactions);
    const totalReactionCount = thumbsUp + thumbsDown + otherReactions;
    if (totalReactionCount === 0) {
      continue;
    }

    records.push({
      findingId: meta.findingId,
      ruleId: meta.ruleId,
      category: meta.category,
      confidence: meta.confidence,
      thumbsUp,
      thumbsDown,
      otherReactions,
    });
  }

  return {
    totalComments,
    withReactions: records.length,
    thumbsUp: records.reduce((sum, record) => sum + record.thumbsUp, 0),
    thumbsDown: records.reduce((sum, record) => sum + record.thumbsDown, 0),
    records,
  };
}

/**
 * Logs an aggregate feedback summary for a job when comments exist.
 *
 * @param feedbackSummary - Aggregated reaction counts from PR comments.
 * @param traceId - End-to-end trace identifier for log stitching.
 * @param jobId - Job identifier for log correlation.
 * @param infoLogger - Logging callback for the summary line. No-op when totalComments is 0.
 */
export function logFeedbackSummary(
  feedbackSummary: CommentFeedbackSummary,
  traceId: string,
  jobId: string,
  infoLogger: (msg: string) => void,
): void {
  if (feedbackSummary.totalComments === 0) {
    return;
  }
  infoLogger(
    `[worker] feedback_summary trace=${traceId} job=${jobId}` +
      ` totalComments=${feedbackSummary.totalComments}` +
      ` withReactions=${feedbackSummary.withReactions}` +
      ` thumbsUp=${feedbackSummary.thumbsUp}` +
      ` thumbsDown=${feedbackSummary.thumbsDown}`,
  );
}

/**
 * Parses the `mergewise-meta` HTML comment from a PR comment body.
 *
 * @param body - Full comment body potentially containing a mergewise-meta marker.
 * @returns Parsed metadata fields, or `null` when the marker is absent or malformed.
 */
export function extractMergewiseMeta(
  body: string,
): { findingId: string; ruleId: string; category: string; confidence: string } | null {
  const match = MERGEWISE_META_REGEX.exec(body);
  const findingId = match?.[1];
  const ruleId = match?.[2];
  const category = match?.[3];
  const confidence = match?.[4];
  if (!findingId || !ruleId || !category || !confidence) {
    return null;
  }
  return { findingId, ruleId, category, confidence };
}

/**
 * Splits {@link GitHubReactionCounts} into thumbs up, thumbs down, and everything else.
 *
 * @param reactions - Reaction counts from a GitHub comment.
 * @returns Grouped reaction totals.
 */
export function sumReactions(reactions: GitHubReactionCounts): {
  thumbsUp: number;
  thumbsDown: number;
  otherReactions: number;
} {
  const thumbsUp = reactions["+1"];
  const thumbsDown = reactions["-1"];
  const otherReactions =
    reactions.laugh +
    reactions.confused +
    reactions.heart +
    reactions.hooray +
    reactions.rocket +
    reactions.eyes;
  return { thumbsUp, thumbsDown, otherReactions };
}
