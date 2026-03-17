import type {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  GitHubIssueComment,
  GitHubPullRequestReview,
  ListPullRequestCommentsOptions,
  ListPullRequestReviewThreadsOptions,
  CreatePullRequestReviewOptions,
  ResolveReviewThreadOptions,
  ResolveReviewThreadResult,
  ReviewThread,
  PostPullRequestSummaryCommentOptions,
  UpdateIssueCommentOptions,
  FetchPullRequestOptions,
  GitHubPullRequest,
  CreateCheckRunOptions,
  UpdateCheckRunOptions,
  GitHubCheckRun,
} from "@mergewise/github-client";
import type { MergewiseConfig } from "@mergewise/config-loader";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import type {
  AnalysisContext,
  CodebaseContext,
  Rule,
} from "@mergewise/shared-types";
import type { FeedbackStore } from "@mergewise/feedback-store";
import type { DebtStore } from "@mergewise/debt-scanner";
import type { WorkerGitHubFetchOptions } from "./config";
import type { WorkerFindingDeliveryOptions } from "./delivery";
import type { fetchPullRequestFilesWithRetry } from "./github-fetch";

/**
 * Logger callbacks used by the worker job processing pipeline.
 */
export interface ResolvedLoggers {
  /** Logs operational info events. */
  readonly infoLogger: (message: string) => void;
  /** Logs error events for failures and diagnostics. */
  readonly errorLogger: (message: string) => void;
  /** Logs warnings for retryable or non-fatal issues. */
  readonly warnLogger: (message: string) => void;
}

/**
 * Dependency overrides for job processing.
 */
export interface WorkerProcessingDependencies {
  /**
   * Rules to execute for pull request analysis.
   */
  readonly rules?: readonly Rule[] | undefined;
  /**
   * Rule execution function override for testing.
   */
  readonly executeRulesFn?: ((
    options: {
      readonly context: AnalysisContext;
      readonly rules: readonly Rule[];
      readonly codebaseContext?: CodebaseContext | undefined;
      readonly onRuleExecutionError?: ((rule: Rule, error: unknown) => void) | undefined;
    },
  ) => Promise<RuleExecutionResult>) | undefined;
  /**
   * Optional override for resolved GitHub fetch options.
   */
  readonly githubFetchOptions?: WorkerGitHubFetchOptions | undefined;
  /**
   * GitHub App JWT creation function override.
   */
  readonly createGitHubAppJwtFn?: (typeof createGitHubAppJwt) | undefined;
  /**
   * Installation token exchange function override.
   */
  readonly exchangeInstallationAccessTokenFn?: (typeof exchangeInstallationAccessToken) | undefined;
  /**
   * Retryable pull request file fetch function override.
   */
  readonly fetchPullRequestFilesWithRetryFn?: (typeof fetchPullRequestFilesWithRetry) | undefined;
  /**
   * Info logger for operational events.
   */
  readonly logInfo?: ((message: string) => void) | undefined;
  /**
   * Error logger for operational events.
   */
  readonly logError?: ((message: string) => void) | undefined;
  /**
   * Warning logger for retryable operational events.
   */
  readonly logWarn?: ((message: string) => void) | undefined;
  /**
   * Time source override for deterministic testing.
   */
  readonly now?: (() => Date) | undefined;
  /**
   * Whether to post findings to GitHub after rule execution.
   */
  readonly deliveryMode?: "none" | "github" | undefined;
  /**
   * Delivery thresholds for confidence gating and posting cap.
   */
  readonly findingDeliveryOptions?: WorkerFindingDeliveryOptions | undefined;
  /**
   * Batch pull request review creation function override.
   */
  readonly createPullRequestReviewFn?: ((
    options: CreatePullRequestReviewOptions,
  ) => Promise<GitHubPullRequestReview>) | undefined;
  /**
   * GitHub check run creation function override.
   */
  readonly createCheckRunFn?: ((
    options: CreateCheckRunOptions,
  ) => Promise<GitHubCheckRun>) | undefined;
  /**
   * GitHub check run update function override.
   */
  readonly updateCheckRunFn?: ((
    options: UpdateCheckRunOptions,
  ) => Promise<GitHubCheckRun>) | undefined;
  /**
   * Review thread resolution function override for testing.
   */
  readonly resolveReviewThreadFn?: ((
    options: ResolveReviewThreadOptions,
  ) => Promise<ResolveReviewThreadResult>) | undefined;
  /**
   * Summary comment listing function override for testing.
   */
  readonly listPullRequestSummaryCommentsFn?: ((
    options: ListPullRequestCommentsOptions,
  ) => Promise<GitHubIssueComment[]>) | undefined;
  /**
   * Review thread listing function override for testing.
   */
  readonly listPullRequestReviewThreadsFn?: ((
    options: ListPullRequestReviewThreadsOptions,
  ) => Promise<ReviewThread[]>) | undefined;
  /**
   * Pull request state fetch function override.
   */
  readonly fetchPullRequestFn?: ((
    options: FetchPullRequestOptions,
  ) => Promise<GitHubPullRequest>) | undefined;
  /**
   * Runtime rule selection and gating config.
   */
  readonly mergewiseConfig?: MergewiseConfig | undefined;
  /**
   * Summary comment creation function override for testing.
   */
  readonly postPullRequestSummaryCommentFn?: ((
    options: PostPullRequestSummaryCommentOptions,
  ) => Promise<GitHubIssueComment>) | undefined;
  /**
   * Issue comment update function override for testing.
   */
  readonly updateIssueCommentFn?: ((
    options: UpdateIssueCommentOptions,
  ) => Promise<GitHubIssueComment>) | undefined;
  /**
   * Persistent store for PR comment reaction feedback.
   */
  readonly feedbackStore?: FeedbackStore | undefined;
  /**
   * Persistent store for repository debt scans and graph context.
   */
  readonly debtStore?: DebtStore;
}
