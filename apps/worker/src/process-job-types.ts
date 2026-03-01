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
