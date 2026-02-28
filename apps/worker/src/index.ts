import {
  listPullRequestReviewThreads,
  listPullRequestSummaryComments,
  createPullRequestReview,
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  resolveReviewThread,
  postPullRequestSummaryComment,
  updateIssueComment,
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
  type PullRequestReviewComment,
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
  type GitHubReactionCounts,
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
  Finding,
  FindingCategory,
  Rule,
} from "@mergewise/shared-types";
import {
  MERGEWISE_META_REGEX,
} from "./comment-formatter";
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
  type PreparedFindingComment,
  prepareFindingDelivery,
  buildWorkerCheckOutput,
} from "./delivery";

export {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
  loadConfig,
  resolveGitHubFetchOptions,
  type WorkerConfig,
  type WorkerGitHubFetchOptions,
} from "./config";

export {
  MERGEWISE_META_REGEX,
  buildStructuredFindingComment,
  wrapCodeIdentifiers,
  isCamelCaseOrPascalCase,
  buildSuggestedRewriteSection,
  buildAdditionalLocationsSection,
  canRenderGitHubSuggestedChange,
  createCodeFence,
  getLongestBacktickRun,
  buildDebugMetadataSection,
} from "./comment-formatter";

export {
  buildAnalysisContext,
  mapGitHubPullRequestFilesToDiffs,
  parsePatchToDiffHunks,
} from "./diff-parser";

export { loadGitHubAppCredentials } from "./github-auth";

export {
  type AnalyzePullRequestJobSummary,
  type WorkerCheckOutput,
  buildIdempotencyKey,
  resolveJobTraceId,
  parseRepositoryFullName,
  buildJobSummary,
  buildSkippedJobSummary,
  selectRulesForExecution,
  applyFindingGates,
  compareFindingsForGating,
} from "./job-utils";

export {
  type WorkerFindingDeliveryOptions,
  type WorkerReviewerSummaryOptions,
  type PreparedFindingComment,
  type PreparedFindingDelivery,
  buildFindingDedupeKey,
  prepareFindingDelivery,
  buildWorkerCheckOutput,
  isTestFilePath,
  buildReviewerSummaryMarkdown,
  formatEvidenceLinksForRule,
  formatEvidenceLocationLink,
} from "./delivery";


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
   * Created GitHub issue comment response.
   */
  readonly createdComment: {
    readonly id: number;
    readonly html_url: string;
    readonly body: string;
    readonly path?: string;
    readonly line?: number;
  };
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

export {
  runPollCycleWithInFlightGuard,
  createPollingLoopController,
  createProcessedKeyState,
  trackProcessedKey,
  type ProcessedKeyState,
  type PollCycleState,
  type WorkerPollingTimerHandle,
  type PollingLoopDependencies,
  type PollingLoopController,
} from "./polling";


/**
 * Posts prepared finding comments and a summary as a single batch pull request review.
 *
 * @param options - Repository coordinates, token, prepared comments, and summary body.
 * @param dependencies - API posting dependency override.
 * @returns Structured summary of successful and failed post attempts.
 */
export async function postPreparedFindingComments(
  options: {
    readonly owner: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly pullRequestHeadSha: string;
    readonly installationAccessToken: string;
    readonly traceId: string;
    readonly githubFetchOptions: WorkerGitHubFetchOptions;
    readonly comments: readonly PreparedFindingComment[];
    readonly summaryBody: string;
  },
  dependencies: {
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
  } = {},
): Promise<PostPreparedFindingCommentsResult> {
  const errorLogger = dependencies.logError ?? console.error;
  const createPullRequestReviewFn =
    dependencies.createPullRequestReviewFn ?? createPullRequestReview;

  let resolvedDedupeKeys: Set<string>;
  if (dependencies.existingDedupeKeys) {
    resolvedDedupeKeys = dependencies.existingDedupeKeys;
  } else {
    const listPullRequestSummaryCommentsFn =
      dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
    const listPullRequestReviewThreadsFn =
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
      {
        listPullRequestSummaryCommentsFn,
        listPullRequestReviewThreadsFn,
      },
    );
    resolvedDedupeKeys = commentState.dedupeKeys;
  }

  const skipped: PostedFindingCommentSkipped[] = [];
  const filteredComments: { readonly index: number; readonly preparedComment: PreparedFindingComment }[] = [];
  for (const [index, preparedComment] of options.comments.entries()) {
    if (resolvedDedupeKeys.has(preparedComment.dedupeKey)) {
      skipped.push({
        index,
        preparedComment,
        reason: "existing_dedupe_key",
      });
      continue;
    }
    filteredComments.push({ index, preparedComment });
  }

  const reviewComments: PullRequestReviewComment[] = filteredComments.map(
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

    const successes: PostedFindingCommentSuccess[] = filteredComments.map(
      ({ index, preparedComment }) => ({
        index,
        preparedComment,
        requestOptions: {
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
        },
        createdComment: {
          id: 0,
          html_url: "",
          body: preparedComment.body,
          path: preparedComment.finding.filePath,
          line: preparedComment.finding.line,
        },
      }),
    );

    return {
      postedCount: successes.length,
      successes,
      failures: [],
      skipped,
    };
  } catch (reviewError) {
    const errorMessage = reviewError instanceof Error
      ? reviewError.message
      : String(reviewError);
    const errorDetail = reviewError instanceof Error
      ? reviewError.stack ?? reviewError.message
      : String(reviewError);
    errorLogger(
      "[worker] batch review post failed" +
        " pr=" + String(options.pullRequestNumber) +
        " commentCount=" + String(filteredComments.length) +
        " error=" + errorDetail,
    );

    const failures: PostedFindingCommentFailure[] = filteredComments.map(
      ({ index, preparedComment }) => ({
        index,
        preparedComment,
        requestOptions: {
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
        },
        errorMessage,
      }),
    );

    return {
      postedCount: 0,
      successes: [],
      failures,
      skipped,
    };
  }
}

/**
 * Resolves review threads whose dedupe keys are absent from the new set or
 * whose anchored code has been changed (GitHub-outdated).
 *
 * @param existingCommentState - Existing comment state with dedupe key → thread ID mapping.
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

async function loadExistingDedupeKeys(
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
  const dedupeKeys = new Set<string>();
  const dedupeKeyToThreadId = new Map<string, string>();
  const allComments: { body: string; reactions?: GitHubReactionCounts }[] = [];
  const outdatedDedupeKeys = new Set<string>();

  try {
    const summaryComments = await dependencies.listPullRequestSummaryCommentsFn(options);
    for (const comment of summaryComments) {
      const dedupeKey = extractDedupeKeyFromCommentBody(comment.body);
      if (dedupeKey) {
        dedupeKeys.add(dedupeKey);
      }
      allComments.push({ body: comment.body, reactions: comment.reactions });
    }
  } catch (caughtError) {
    const errorDetail = caughtError instanceof Error
      ? caughtError.stack ?? caughtError.message
      : String(caughtError);
    console.error(
      "[worker] failed to list summary comments for dedupe owner=" +
        options.owner +
        " repo=" +
        options.repository +
        " pr=" +
        String(options.pullRequestNumber) +
        " error=" +
        errorDetail,
    );
  }

  try {
    const reviewThreads = await dependencies.listPullRequestReviewThreadsFn({
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
      allComments.push({ body: thread.firstCommentBody });
      if (thread.isResolved) {
        continue;
      }
      const dedupeKey = extractDedupeKeyFromCommentBody(thread.firstCommentBody);
      if (!dedupeKey) {
        continue;
      }
      dedupeKeys.add(dedupeKey);
      dedupeKeyToThreadId.set(dedupeKey, thread.id);
      if (thread.isOutdated) {
        outdatedDedupeKeys.add(dedupeKey);
      }
    }
  } catch (caughtError) {
    const errorDetail = caughtError instanceof Error
      ? caughtError.stack ?? caughtError.message
      : String(caughtError);
    console.error(
      "[worker] failed to list review threads for dedupe owner=" +
        options.owner +
        " repo=" +
        options.repository +
        " pr=" +
        String(options.pullRequestNumber) +
        " error=" +
        errorDetail,
    );
  }

  return { dedupeKeys, dedupeKeyToThreadId, allComments, outdatedDedupeKeys };
}

function extractDedupeKeyFromCommentBody(commentBody: string | undefined): string | null {
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

function logFeedbackSummary(
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


/**
 * Parses the `mergewise-meta` HTML comment from a PR comment body.
 *
 * @param body - Full comment body potentially containing a mergewise-meta marker.
 * @returns Parsed metadata fields, or `null` when the marker is absent or malformed.
 */
function extractMergewiseMeta(
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
 * `+1` maps to `thumbsUp`, `-1` maps to `thumbsDown`. The remaining six reaction types
 * (`laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) are summed into `otherReactions`.
 *
 * @param reactions - Reaction counts from a GitHub comment.
 * @returns Grouped reaction totals.
 */
function sumReactions(reactions: GitHubReactionCounts): {
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


async function buildAnalysisContextFromGitHub(
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


const PR_SUMMARY_COMMENT_MARKER = "<!-- mergewise-summary -->";

/**
 * Input for {@link buildPrSummaryComment}.
 */
export interface PrSummaryInput {
  /** Relative paths of all files included in the review. */
  readonly filePaths: readonly string[];
  /** Gated findings produced by the analysis pipeline. */
  readonly findings: readonly Finding[];
  /** Repository in `owner/name` format for blob links. */
  readonly repositoryFullName: string;
  /** PR head commit SHA used to construct permalink URLs. */
  readonly headSha: string;
  /** Total number of rules that were executed. */
  readonly rulesRan: number;
  /** Number of rules that completed without errors. */
  readonly rulesPassed: number;
}

const CATEGORY_EMOJI: Readonly<Record<FindingCategory, string>> = {
  safety: "🔴",
  perf: "🟡",
  clean: "🔵",
  idiomatic: "🟢",
};

const CATEGORY_SEVERITY_ORDER: readonly FindingCategory[] = [
  "safety",
  "perf",
  "clean",
  "idiomatic",
];

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

interface FindingGroup {
  readonly category: FindingCategory;
  readonly recommendation: string;
  readonly locations: readonly { readonly filePath: string; readonly line: number }[];
}

function buildBlobUrl(
  repositoryFullName: string,
  headSha: string,
  filePath: string,
  line: number,
): string {
  const encodedFilePath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedLine = Math.max(1, line);
  return (
    `https://github.com/${repositoryFullName}` +
    `/blob/${encodeURIComponent(headSha)}/${encodedFilePath}#L${String(normalizedLine)}`
  );
}

function buildLocationLink(
  repositoryFullName: string,
  headSha: string,
  filePath: string,
  line: number,
): string {
  const blobUrl = buildBlobUrl(repositoryFullName, headSha, filePath, line);
  return `[\`${filePath}:${String(line)}\`](${blobUrl})`;
}

const INLINE_LOCATION_THRESHOLD = 4;

function groupFindings(findings: readonly Finding[]): FindingGroup[] {
  const groupMap = new Map<string, FindingGroup & { locations: { filePath: string; line: number }[] }>();

  for (const finding of findings) {
    const key = `${finding.ruleId}\0${finding.recommendation}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.locations.push({ filePath: finding.filePath, line: finding.line });
    } else {
      groupMap.set(key, {
        category: finding.category,
        recommendation: finding.recommendation,
        locations: [{ filePath: finding.filePath, line: finding.line }],
      });
    }
  }

  const groups = [...groupMap.values()];

  for (const group of groups) {
    group.locations.sort((left, right) => {
      const fileCompare = left.filePath.localeCompare(right.filePath);
      if (fileCompare !== 0) return fileCompare;
      return left.line - right.line;
    });
  }

  groups.sort((left, right) => {
    const severityDiff =
      CATEGORY_SEVERITY_ORDER.indexOf(left.category) -
      CATEGORY_SEVERITY_ORDER.indexOf(right.category);
    if (severityDiff !== 0) return severityDiff;
    const leftFile = left.locations[0]?.filePath ?? "";
    const rightFile = right.locations[0]?.filePath ?? "";
    return leftFile.localeCompare(rightFile);
  });

  return groups;
}

function buildCollapsibleDetail(
  group: FindingGroup,
  repositoryFullName: string,
  headSha: string,
): string[] {
  const emoji = CATEGORY_EMOJI[group.category];
  const uniqueFiles = [...new Set(group.locations.map((loc) => loc.filePath))].sort();
  const truncatedRecommendation =
    group.recommendation.length > 60
      ? group.recommendation.slice(0, 57) + "..."
      : group.recommendation;

  const lines: string[] = [
    "<details>",
    `<summary>${emoji} ${String(group.locations.length)} × ${escapeTableCell(truncatedRecommendation)} (${String(uniqueFiles.length)} file${uniqueFiles.length === 1 ? "" : "s"})</summary>`,
    "",
  ];

  for (const file of uniqueFiles) {
    const fileLines = group.locations
      .filter((loc) => loc.filePath === file)
      .map((loc) => {
        const blobUrl = buildBlobUrl(repositoryFullName, headSha, file, loc.line);
        return `[${String(loc.line)}](${blobUrl})`;
      });
    lines.push(`- \`${file}\` — lines ${fileLines.join(", ")}`);
  }

  lines.push("", "</details>");
  return lines;
}

/**
 * Builds the Markdown body for the PR summary comment.
 *
 * Findings with the same rule and recommendation are grouped into a single
 * table row. Groups with four or more locations render a collapsible detail
 * section listing every affected file and line.
 */
export function buildPrSummaryComment(input: PrSummaryInput): string {
  const { filePaths, findings, repositoryFullName, headSha, rulesRan, rulesPassed } = input;
  const fileCount = filePaths.length;
  const lines: string[] = [PR_SUMMARY_COMMENT_MARKER, "## Mergewise Review Summary", ""];

  const fileStat = `**${fileCount}** file${fileCount === 1 ? "" : "s"} reviewed`;
  const ruleStat = `**${rulesPassed}/${rulesRan}** rules passed`;

  if (findings.length > 0) {
    const findingStat =
      `**${findings.length}** finding${findings.length === 1 ? "" : "s"}`;
    lines.push(`${fileStat} · ${findingStat} · ${ruleStat}`, "");
  } else {
    lines.push(`${fileStat} · ✅ No issues found · ${ruleStat}`, "");
  }

  if (findings.length > 0) {
    const groups = groupFindings(findings);
    const collapsibleSections: string[][] = [];

    lines.push("| Severity | Recommendation | Locations |", "| --- | --- | --- |");
    for (const group of groups) {
      const emoji = CATEGORY_EMOJI[group.category];
      const safeRecommendation = escapeTableCell(group.recommendation);
      let locationCell: string;

      if (group.locations.length < INLINE_LOCATION_THRESHOLD) {
        locationCell = group.locations
          .map((loc) => buildLocationLink(repositoryFullName, headSha, loc.filePath, loc.line))
          .join(", ");
      } else {
        const uniqueFiles = new Set(group.locations.map((loc) => loc.filePath));
        locationCell =
          `${String(group.locations.length)} locations across ` +
          `${String(uniqueFiles.size)} file${uniqueFiles.size === 1 ? "" : "s"}`;
        collapsibleSections.push(
          buildCollapsibleDetail(group, repositoryFullName, headSha),
        );
      }

      lines.push(
        `| ${emoji} ${group.category} | ${safeRecommendation} | ${locationCell} |`,
      );
    }
    lines.push("");

    for (const section of collapsibleSections) {
      lines.push(...section, "");
    }
  }

  if (fileCount > 0) {
    lines.push(
      "<details>",
      `<summary>Files reviewed (${fileCount})</summary>`,
      "",
    );
    const sortedPaths = [...filePaths].sort((left, right) => left.localeCompare(right));
    for (const filePath of sortedPaths) {
      lines.push(`- \`${filePath}\``);
    }
    lines.push("", "</details>");
  }

  return lines.join("\n");
}

/**
 * Upserts the PR summary comment by finding an existing comment with the
 * hidden marker or creating a new one.
 *
 * @param options - Repository coordinates, token, and comment body.
 * @param dependencies - API function overrides for testing.
 * @returns The created or updated comment.
 */
export async function upsertPrSummaryComment(
  options: {
    readonly owner: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly installationAccessToken: string;
    readonly body: string;
    readonly traceId: string;
    readonly githubFetchOptions: WorkerGitHubFetchOptions;
  },
  dependencies: {
    readonly listPullRequestSummaryCommentsFn?: (
      opts: ListPullRequestCommentsOptions,
    ) => Promise<GitHubIssueComment[]>;
    readonly postPullRequestSummaryCommentFn?: (
      opts: PostPullRequestSummaryCommentOptions,
    ) => Promise<GitHubIssueComment>;
    readonly updateIssueCommentFn?: (
      opts: UpdateIssueCommentOptions,
    ) => Promise<GitHubIssueComment>;
    readonly logInfo?: (message: string) => void;
    readonly logError?: (message: string) => void;
  } = {},
): Promise<GitHubIssueComment> {
  const listFn = dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
  const postFn = dependencies.postPullRequestSummaryCommentFn ?? postPullRequestSummaryComment;
  const updateFn = dependencies.updateIssueCommentFn ?? updateIssueComment;
  const infoLogger = dependencies.logInfo ?? console.log;

  const existingComments = await listFn({
    owner: options.owner,
    repository: options.repository,
    pullRequestNumber: options.pullRequestNumber,
    installationAccessToken: options.installationAccessToken,
    apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
    userAgent: options.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    traceId: options.traceId,
  });

  const existingSummaryComment = existingComments.find(
    (comment) => comment.body.includes(PR_SUMMARY_COMMENT_MARKER),
  );

  if (existingSummaryComment) {
    infoLogger(
      `[worker] updating_summary_comment trace=${options.traceId} commentId=${existingSummaryComment.id}`,
    );
    return updateFn({
      owner: options.owner,
      repository: options.repository,
      commentId: existingSummaryComment.id,
      installationAccessToken: options.installationAccessToken,
      body: options.body,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    });
  }

  infoLogger(
    `[worker] creating_summary_comment trace=${options.traceId}`,
  );
  return postFn({
    owner: options.owner,
    repository: options.repository,
    pullRequestNumber: options.pullRequestNumber,
    installationAccessToken: options.installationAccessToken,
    body: options.body,
    apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
    userAgent: options.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    traceId: options.traceId,
  });
}


function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryablePullRequestFileFetchError(error: unknown): boolean {
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

