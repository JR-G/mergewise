import {
  postPullRequestSummaryComment,
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  type FetchPullRequestFilesOptions,
  type GitHubPullRequestFile,
  type PostPullRequestSummaryCommentOptions,
} from "@mergewise/github-client";
import {
  DEFAULT_MERGEWISE_CONFIG,
  type MergewiseConfig,
} from "@mergewise/config-loader";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { executeRules } from "@mergewise/rule-engine";
import { tsReactRules } from "@mergewise/rule-ts-react";
import type {
  AnalysisContext,
  AnalyzePullRequestJob,
  DiffHunk,
  FileDiff,
  Finding,
  FindingCategory,
  Rule,
} from "@mergewise/shared-types";

/**
 * Runtime configuration for the worker process.
 */
export interface WorkerConfig {
  /**
   * Poll interval in milliseconds for local queue file checks.
   */
  pollIntervalMs: number;
  /**
   * Maximum count of idempotency keys retained in memory.
   */
  maxProcessedKeys: number;
  /**
   * Base URL for GitHub API requests.
   */
  githubApiBaseUrl: string;
  /**
   * User-Agent header for GitHub API requests.
   */
  githubUserAgent: string;
  /**
   * Timeout for each GitHub API request in milliseconds.
   */
  githubRequestTimeoutMs: number;
  /**
   * Maximum retry count for pull request file fetch failures.
   */
  githubFetchRetries: number;
  /**
   * Delay between pull request file fetch retries in milliseconds.
   */
  githubRetryDelayMs: number;
  /**
   * Minimum confidence required for findings to be posted to GitHub.
   */
  confidenceThreshold: number;
  /**
   * Maximum number of findings posted per pull request.
   */
  maxComments: number;
}

/**
 * Runtime options for fetching pull request files in the worker.
 */
export interface WorkerGitHubFetchOptions {
  /**
   * Base URL for GitHub API requests.
   */
  readonly githubApiBaseUrl: string;
  /**
   * User-Agent header for GitHub API requests.
   */
  readonly githubUserAgent: string;
  /**
   * Timeout for each GitHub API request in milliseconds.
   */
  readonly githubRequestTimeoutMs: number;
  /**
   * Maximum retry count for pull request file fetch failures.
   */
  readonly githubFetchRetries: number;
  /**
   * Delay between pull request file fetch retries in milliseconds.
   */
  readonly githubRetryDelayMs: number;
}

/**
 * Summary payload emitted after one job finishes rule execution.
 *
 * @remarks
 * This summary is intentionally small and deterministic so it can be logged,
 * tested, and passed to the next delivery step that posts PR summaries.
 */
export interface AnalyzePullRequestJobSummary {
  /**
   * Job identifier.
   */
  readonly jobId: string;
  /**
   * Stable worker idempotency key.
   */
  readonly idempotencyKey: string;
  /**
   * Repository full name in `owner/name` format.
   */
  readonly repository: string;
  /**
   * Pull request number.
   */
  readonly pullRequestNumber: number;
  /**
   * Pull request head commit SHA.
   */
  readonly headSha: string;
  /**
   * Number of findings emitted by successful rules.
   */
  readonly totalFindings: number;
  /**
   * Finding counts grouped by category.
   */
  readonly findingsByCategory: Readonly<Record<FindingCategory, number>>;
  /**
   * Number of rules requested by the worker.
   */
  readonly totalRules: number;
  /**
   * Number of rules that completed without throwing.
   */
  readonly successfulRules: number;
  /**
   * Number of rules that threw and were skipped.
   */
  readonly failedRules: number;
  /**
   * Rule identifiers that failed.
   */
  readonly failedRuleIds: readonly string[];
  /**
   * UTC timestamp when processing completed.
   */
  readonly processedAt: string;
  /**
   * Number of PR comments posted for findings.
   */
  readonly postedCommentCount?: number;
  /**
   * Number of findings skipped for confidence threshold.
   */
  readonly skippedByConfidence?: number;
  /**
   * Number of findings skipped due to deduplication.
   */
  readonly skippedByDeduplication?: number;
  /**
   * Number of findings skipped due to maximum comment cap.
   */
  readonly skippedByCap?: number;
  /**
   * Structured check output payload for PR status reporting.
   */
  readonly checkOutput?: WorkerCheckOutput;
}

/**
 * Delivery options for finding-to-GitHub posting.
 */
export interface WorkerFindingDeliveryOptions {
  /**
   * Minimum confidence required for inclusion.
   */
  readonly confidenceThreshold: number;
  /**
   * Maximum number of findings posted as comments.
   */
  readonly maxComments: number;
}

/**
 * Structured check output shape compatible with GitHub checks APIs.
 */
export interface WorkerCheckOutput {
  /**
   * Short check output title.
   */
  readonly title: string;
  /**
   * One-paragraph summary for the check run.
   */
  readonly summary: string;
  /**
   * Optional markdown details body.
   */
  readonly text: string;
}

/**
 * Options used to render reviewer-facing summary links in check output details.
 */
export interface WorkerReviewerSummaryOptions {
  /**
   * Repository full name in `owner/name` format.
   */
  readonly repositoryFullName: string;
  /**
   * Pull request head commit SHA used for blob links.
   */
  readonly headSha: string;
  /**
   * Maximum evidence links shown per rule group.
   */
  readonly maxEvidenceLinksPerRule?: number;
}

/**
 * Prepared finding comment payload with stable dedupe key.
 */
export interface PreparedFindingComment {
  /**
   * Stable dedupe key for this finding.
   */
  readonly dedupeKey: string;
  /**
   * Source finding.
   */
  readonly finding: Finding;
  /**
   * Markdown body posted to GitHub.
   */
  readonly body: string;
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
}

/**
 * Deterministic finding selection and formatting result.
 */
export interface PreparedFindingDelivery {
  /**
   * Findings selected for GitHub PR comments.
   */
  readonly comments: readonly PreparedFindingComment[];
  /**
   * Findings rejected for low confidence.
   */
  readonly skippedByConfidence: number;
  /**
   * Findings removed due to dedupe key collision.
   */
  readonly skippedByDeduplication: number;
  /**
   * Findings rejected due to maximum comment cap.
   */
  readonly skippedByCap: number;
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
   * Comment-post function override.
   */
  readonly postPullRequestSummaryCommentFn?: (
    options: PostPullRequestSummaryCommentOptions,
  ) => Promise<{ id: number; html_url: string; body: string }>;
  /**
   * Runtime rule selection and gating config.
   */
  readonly mergewiseConfig?: MergewiseConfig;
}

/**
 * In-memory state for idempotency key tracking.
 *
 * @remarks
 * Properties are `readonly` to prevent reference reassignment. The underlying
 * collections are mutated in place by {@link trackProcessedKey}.
 */
export interface ProcessedKeyState {
  /** Set of currently tracked keys for O(1) lookup. Mutated by trackProcessedKey. */
  readonly keys: Set<string>;
  /** Insertion-ordered list for FIFO eviction. Mutated by trackProcessedKey. */
  readonly order: string[];
}

/**
 * Mutable state tracking whether one poll cycle is currently active.
 */
export interface PollCycleState {
  /**
   * Indicates whether poll execution is currently in flight.
   */
  isPollInFlight: boolean;
}

/**
 * Timer handle type used by worker polling lifecycle controls.
 */
export type WorkerPollingTimerHandle = ReturnType<typeof setInterval>;

/**
 * Dependency overrides for polling loop interval lifecycle.
 */
export interface PollingLoopDependencies {
  /**
   * Interval scheduler implementation.
   */
  readonly setIntervalFn?: (
    callback: () => void,
    delayMs: number,
  ) => WorkerPollingTimerHandle;
  /**
   * Interval cancellation implementation.
   */
  readonly clearIntervalFn?: (timerHandle: WorkerPollingTimerHandle) => void;
  /**
   * Error logger for poll lifecycle failures.
   */
  readonly logError?: (message: string) => void;
}

/**
 * Lifecycle controller for worker polling intervals.
 */
export interface PollingLoopController {
  /**
   * Starts periodic polling when not already running.
   */
  start: () => void;
  /**
   * Stops periodic polling and waits for in-flight poll completion.
   */
  stop: () => Promise<void>;
  /**
   * Indicates whether the interval is currently active.
   */
  isRunning: () => boolean;
}

/**
 * Loads worker runtime configuration from environment variables.
 *
 * @returns Validated worker configuration.
 */
export function loadConfig(): WorkerConfig {
  const pollRaw = process.env.WORKER_POLL_INTERVAL_MS ?? "3000";
  const pollIntervalMs = Number.parseInt(pollRaw, 10);
  const maxKeysRaw = process.env.WORKER_MAX_PROCESSED_KEYS ?? "10000";
  const maxProcessedKeys = Number.parseInt(maxKeysRaw, 10);
  const githubApiBaseUrl = process.env.GITHUB_API_BASE_URL ?? "https://api.github.com";
  const githubUserAgent = process.env.WORKER_GITHUB_USER_AGENT ?? "mergewise-worker";
  const timeoutRaw = process.env.WORKER_GITHUB_REQUEST_TIMEOUT_MS ?? "10000";
  const githubRequestTimeoutMs = Number.parseInt(timeoutRaw, 10);
  const retriesRaw = process.env.WORKER_GITHUB_FETCH_RETRIES ?? "2";
  const githubFetchRetries = Number.parseInt(retriesRaw, 10);
  const retryDelayRaw = process.env.WORKER_GITHUB_RETRY_DELAY_MS ?? "250";
  const githubRetryDelayMs = Number.parseInt(retryDelayRaw, 10);
  const confidenceThresholdRaw =
    process.env.WORKER_FINDING_CONFIDENCE_THRESHOLD ?? "0.78";
  const confidenceThreshold = Number.parseFloat(confidenceThresholdRaw);
  const maxCommentsRaw = process.env.WORKER_FINDING_MAX_COMMENTS ?? "20";
  const maxComments = Number.parseInt(maxCommentsRaw, 10);

  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 250) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS value: ${pollRaw}`);
  }

  if (Number.isNaN(maxProcessedKeys) || maxProcessedKeys < 100) {
    throw new Error(`Invalid WORKER_MAX_PROCESSED_KEYS value: ${maxKeysRaw}`);
  }

  if (!githubApiBaseUrl.trim()) {
    throw new Error("Invalid GITHUB_API_BASE_URL value: empty");
  }

  if (!githubUserAgent.trim()) {
    throw new Error("Invalid WORKER_GITHUB_USER_AGENT value: empty");
  }

  if (Number.isNaN(githubRequestTimeoutMs) || githubRequestTimeoutMs < 100) {
    throw new Error(`Invalid WORKER_GITHUB_REQUEST_TIMEOUT_MS value: ${timeoutRaw}`);
  }

  if (Number.isNaN(githubFetchRetries) || githubFetchRetries < 0) {
    throw new Error(`Invalid WORKER_GITHUB_FETCH_RETRIES value: ${retriesRaw}`);
  }

  if (Number.isNaN(githubRetryDelayMs) || githubRetryDelayMs < 10) {
    throw new Error(`Invalid WORKER_GITHUB_RETRY_DELAY_MS value: ${retryDelayRaw}`);
  }

  if (
    Number.isNaN(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  ) {
    throw new Error(
      `Invalid WORKER_FINDING_CONFIDENCE_THRESHOLD value: ${confidenceThresholdRaw}`,
    );
  }

  if (Number.isNaN(maxComments) || maxComments < 1) {
    throw new Error(`Invalid WORKER_FINDING_MAX_COMMENTS value: ${maxCommentsRaw}`);
  }

  return {
    pollIntervalMs,
    maxProcessedKeys,
    githubApiBaseUrl,
    githubUserAgent,
    githubRequestTimeoutMs,
    githubFetchRetries,
    githubRetryDelayMs,
    confidenceThreshold,
    maxComments,
  };
}

/**
 * Builds a stable dedupe key for finding delivery.
 *
 * @param finding - Finding to derive key from.
 * @returns Stable per-finding delivery key.
 */
export function buildFindingDedupeKey(finding: Finding): string {
  const normalizedFindingId = finding.findingId.trim();
  if (normalizedFindingId) {
    return `${finding.repo}#${finding.prNumber}:${normalizedFindingId}`;
  }

  return `${finding.repo}#${finding.prNumber}:${finding.ruleId}:${finding.filePath}:${finding.line}`;
}

/**
 * Prepares deterministic, bounded PR comment payloads from rule findings.
 *
 * @remarks
 * Selection order is deterministic and independent of input ordering.
 * Findings are sorted by confidence descending, then by stable dedupe key.
 *
 * @param findings - Findings emitted by rule execution.
 * @param options - Confidence threshold and posting cap.
 * @returns Prepared comments and skip counters.
 */
export function prepareFindingDelivery(
  findings: readonly Finding[],
  options: WorkerFindingDeliveryOptions,
): PreparedFindingDelivery {
  const skippedByConfidenceCandidates = findings.filter(
    (finding) => finding.confidence < options.confidenceThreshold,
  );
  const confidencePassing = findings.filter(
    (finding) => finding.confidence >= options.confidenceThreshold,
  );
  const sortedFindings = [...confidencePassing].sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    const leftKey = buildFindingDedupeKey(left);
    const rightKey = buildFindingDedupeKey(right);
    return leftKey.localeCompare(rightKey);
  });

  const seenKeys = new Set<string>();
  const deduplicatedFindings: Finding[] = [];
  let skippedByDeduplication = 0;
  for (const finding of sortedFindings) {
    const dedupeKey = buildFindingDedupeKey(finding);
    if (seenKeys.has(dedupeKey)) {
      skippedByDeduplication += 1;
      continue;
    }

    seenKeys.add(dedupeKey);
    deduplicatedFindings.push(finding);
  }

  const selectedFindings = deduplicatedFindings.slice(0, options.maxComments);
  const skippedByCap = Math.max(deduplicatedFindings.length - selectedFindings.length, 0);
  const comments = selectedFindings.map((finding) => {
    const dedupeKey = buildFindingDedupeKey(finding);
    return {
      dedupeKey,
      finding,
      body: buildStructuredFindingComment(finding, dedupeKey),
    };
  });

  return {
    comments,
    skippedByConfidence: skippedByConfidenceCandidates.length,
    skippedByDeduplication,
    skippedByCap,
  };
}

/**
 * Builds structured check output from delivery and execution summaries.
 *
 * @param executionResult - Rule execution result.
 * @param delivery - Prepared delivery output.
 * @param postedCount - Number of comments that were actually posted.
 * @param reviewerSummaryOptions - Optional `WorkerReviewerSummaryOptions` used to build reviewer summary evidence links with repository/head context and link limits; when omitted, reviewer summary falls back to plain location labels.
 * @returns Structured check output payload.
 */
export function buildWorkerCheckOutput(
  executionResult: RuleExecutionResult,
  delivery: PreparedFindingDelivery,
  postedCount: number,
  reviewerSummaryOptions?: WorkerReviewerSummaryOptions,
): WorkerCheckOutput {
  const totalFindings = executionResult.summary.totalFindings;
  const reviewerSummaryMarkdown = buildReviewerSummaryMarkdown(
    delivery.comments,
    reviewerSummaryOptions,
  );
  const deliveryCounterMarkdown = [
    "### Delivery Counters",
    `- skipped_by_confidence=${delivery.skippedByConfidence}`,
    `- skipped_by_deduplication=${delivery.skippedByDeduplication}`,
    `- skipped_by_cap=${delivery.skippedByCap}`,
  ].join("\n");

  return {
    title: `Mergewise Findings (${postedCount} posted of ${totalFindings})`,
    summary:
      `Rules=${executionResult.summary.successfulRules}/${executionResult.summary.totalRules}` +
      ` findings=${totalFindings} posted=${postedCount}`,
    text: `${reviewerSummaryMarkdown}\n\n${deliveryCounterMarkdown}`,
  };
}

function buildReviewerSummaryMarkdown(
  comments: readonly PreparedFindingComment[],
  options?: WorkerReviewerSummaryOptions,
): string {
  if (comments.length === 0) {
    return "### Reviewer Summary\nNo findings selected for reviewer output.";
  }

  const groupedByCategory = new Map<FindingCategory, Map<string, Finding[]>>();
  for (const preparedComment of comments) {
    const finding = preparedComment.finding;
    const groupedByRule = groupedByCategory.get(finding.category) ?? new Map<string, Finding[]>();
    const findingsForRule = groupedByRule.get(finding.ruleId) ?? [];
    groupedByRule.set(finding.ruleId, [...findingsForRule, finding]);
    groupedByCategory.set(finding.category, groupedByRule);
  }

  const categoryOrder: readonly FindingCategory[] = ["safety", "perf", "clean", "idiomatic"];
  const orderedCategories = [...groupedByCategory.entries()].sort(([leftCategory], [rightCategory]) => {
    const leftIndex = categoryOrder.indexOf(leftCategory);
    const rightIndex = categoryOrder.indexOf(rightCategory);
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return leftCategory.localeCompare(rightCategory);
  });

  const summaryLines: string[] = ["### Reviewer Summary"];
  for (const [category, groupedByRule] of orderedCategories) {
    const sortedRuleEntries = [...groupedByRule.entries()].sort(([leftRuleId], [rightRuleId]) =>
      leftRuleId.localeCompare(rightRuleId),
    );
    const categoryCount = sortedRuleEntries.reduce(
      (totalCount, [, findings]) => totalCount + findings.length,
      0,
    );
    summaryLines.push(`- \`${category}\` (${categoryCount})`);

    for (const [ruleId, findings] of sortedRuleEntries) {
      const sortedFindings = [...findings].sort(compareFindingsForGating);
      const evidenceLinksMarkdown = formatEvidenceLinksForRule(sortedFindings, options);
      summaryLines.push(
        `  - \`${ruleId}\` (${findings.length}): ${evidenceLinksMarkdown.join(", ")}`,
      );
    }
  }

  return summaryLines.join("\n");
}

function formatEvidenceLinksForRule(
  findings: readonly Finding[],
  options?: WorkerReviewerSummaryOptions,
): readonly string[] {
  const maxEvidenceLinksPerRule = options?.maxEvidenceLinksPerRule ?? 3;
  const uniqueLocations = new Set<string>();
  const evidenceLinks: string[] = [];

  for (const finding of findings) {
    const locationKey = `${finding.filePath}:${finding.line}`;
    if (uniqueLocations.has(locationKey)) {
      continue;
    }

    uniqueLocations.add(locationKey);
    evidenceLinks.push(formatEvidenceLocationLink(finding, options));
    if (evidenceLinks.length >= maxEvidenceLinksPerRule) {
      break;
    }
  }

  return evidenceLinks;
}

function formatEvidenceLocationLink(
  finding: Finding,
  options?: WorkerReviewerSummaryOptions,
): string {
  const locationLabel = `${finding.filePath}:${finding.line}`;
  if (!options) {
    return `\`${locationLabel}\``;
  }

  const encodedFilePath = finding.filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedLineNumber = Math.max(1, finding.line);
  const blobUrl =
    `https://github.com/${options.repositoryFullName}` +
    `/blob/${encodeURIComponent(options.headSha)}/${encodedFilePath}#L${String(normalizedLineNumber)}`;
  return `[${locationLabel}](${blobUrl})`;
}

/**
 * Posts prepared finding comments to a pull request.
 *
 * @param options - Repository coordinates, token, and prepared comments.
 * @param dependencies - API posting dependency override.
 * @returns Structured summary of successful and failed post attempts.
 */
export async function postPreparedFindingComments(
  options: {
    readonly owner: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly installationAccessToken: string;
    readonly githubFetchOptions: WorkerGitHubFetchOptions;
    readonly comments: readonly PreparedFindingComment[];
  },
  dependencies: {
    readonly postPullRequestSummaryCommentFn?: (
      options: PostPullRequestSummaryCommentOptions,
    ) => Promise<{ id: number; html_url: string; body: string }>;
  } = {},
): Promise<PostPreparedFindingCommentsResult> {
  const postPullRequestSummaryCommentFn =
    dependencies.postPullRequestSummaryCommentFn ?? postPullRequestSummaryComment;

  const successes: PostedFindingCommentSuccess[] = [];
  const failures: PostedFindingCommentFailure[] = [];
  for (const [index, preparedComment] of options.comments.entries()) {
    const requestOptions: PostPullRequestSummaryCommentOptions = {
      owner: options.owner,
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      installationAccessToken: options.installationAccessToken,
      body: preparedComment.body,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    };
    const sanitizedRequestOptions = sanitizePostCommentRequestOptionsForLogging(requestOptions);

    try {
      const createdComment = await postPullRequestSummaryCommentFn(requestOptions);
      successes.push({
        index,
        preparedComment,
        requestOptions: sanitizedRequestOptions,
        createdComment,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorDetail = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(
        "[worker] failed to post finding comment index=" +
          String(index) +
          " dedupeKey=" +
          preparedComment.dedupeKey +
          " requestOptions=" +
          JSON.stringify(sanitizedRequestOptions) +
          " error=" +
          errorDetail,
      );
      failures.push({
        index,
        preparedComment,
        requestOptions: sanitizedRequestOptions,
        errorMessage,
      });
    }
  }

  return {
    postedCount: successes.length,
    successes,
    failures,
  };
}

/**
 * Builds a redacted logging payload for one PR comment post request.
 *
 * @param requestOptions - Raw post request options containing the installation token.
 * @returns Safe request options for logs with token removed.
 */
function sanitizePostCommentRequestOptionsForLogging(
  requestOptions: PostPullRequestSummaryCommentOptions,
): PostedCommentRequestOptions {
  return {
    ...requestOptions,
    installationAccessToken: "[REDACTED]",
  };
}

/**
 * Builds a stable idempotency key for queued analysis jobs.
 *
 * @param job - Pull request analysis job payload.
 * @returns Stable idempotency key scoped to repository PR head SHA.
 */
export function buildIdempotencyKey(job: AnalyzePullRequestJob): string {
  return `${job.repo_full_name}#${job.pr_number}@${job.head_sha}`;
}

/**
 * Parses a `repo_full_name` value into owner and repository segments.
 *
 * @param repoFullName - Repository name in `owner/name` format.
 * @returns Parsed owner/repository tuple, or `null` when malformed.
 */
export function parseRepositoryFullName(
  repoFullName: string,
): Readonly<{ owner: string; repository: string }> | null {
  const segments = repoFullName.split("/");
  if (segments.length !== 2) {
    return null;
  }

  const owner = segments[0]?.trim() ?? "";
  const repository = segments[1]?.trim() ?? "";
  if (!owner || !repository) {
    return null;
  }

  return { owner, repository };
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
 * Builds rule-engine analysis context from fetched GitHub file metadata.
 *
 * @param job - Job payload.
 * @param fileDiffs - Parsed file diffs for the pull request.
 * @returns Rule-engine analysis context.
 */
export function buildAnalysisContext(
  job: AnalyzePullRequestJob,
  fileDiffs: readonly FileDiff[],
): AnalysisContext {
  return {
    diffs: fileDiffs,
    pullRequest: {
      repo: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      installationId: job.installation_id,
    },
  };
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
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;
  const warnLogger = dependencies.logWarn ?? infoLogger ?? errorLogger;
  const rules = dependencies.rules ?? tsReactRules;
  const mergewiseConfig = dependencies.mergewiseConfig ?? DEFAULT_MERGEWISE_CONFIG;
  const selectedRules = selectRulesForExecution(rules, mergewiseConfig);
  const executeRulesFn = dependencies.executeRulesFn ?? executeRules;
  const githubFetchOptions = dependencies.githubFetchOptions ?? resolveGitHubFetchOptions();
  const findingDeliveryOptions = dependencies.findingDeliveryOptions ?? {
    confidenceThreshold: mergewiseConfig.gating.confidenceThreshold,
    maxComments: mergewiseConfig.gating.maxComments,
  };

  infoLogger(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"} rules=${selectedRules.length}`,
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

  const executionResult = await executeRulesFn({
    context: githubAnalysisContext.analysisContext,
    rules: selectedRules,
    onRuleExecutionError: (rule, error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(
        `[worker] rule failure job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
      );
    },
  });
  const gatedExecutionResult = applyFindingGates(executionResult, mergewiseConfig);
  const delivery = prepareFindingDelivery(executionResult.findings, findingDeliveryOptions);

  let postedCommentCount = 0;
  if (dependencies.deliveryMode === "github" && delivery.comments.length > 0) {
    const postingResult = await postPreparedFindingComments(
      {
        owner: githubAnalysisContext.owner,
        repository: githubAnalysisContext.repository,
        pullRequestNumber: job.pr_number,
        installationAccessToken: githubAnalysisContext.installationAccessToken,
        githubFetchOptions,
        comments: delivery.comments,
      },
      {
        postPullRequestSummaryCommentFn: dependencies.postPullRequestSummaryCommentFn,
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
    `[worker] summary job=${summary.jobId} findings=${summary.totalFindings} rules_ok=${summary.successfulRules}/${summary.totalRules}`,
  );
  infoLogger(
    `[worker] check_output job=${summary.jobId} payload=${JSON.stringify(checkOutput)}`,
  );

  return {
    ...summary,
    postedCommentCount,
    skippedByConfidence: delivery.skippedByConfidence,
    skippedByDeduplication: delivery.skippedByDeduplication,
    skippedByCap: delivery.skippedByCap,
    checkOutput,
  };
}

/**
 * Executes one poll cycle while preventing overlapping runs.
 *
 * @param state - Mutable poll cycle state.
 * @param pollCycle - Poll cycle callback.
 * @returns `true` when execution ran, or `false` when skipped due to in-flight work.
 */
export async function runPollCycleWithInFlightGuard(
  state: PollCycleState,
  pollCycle: () => Promise<void>,
): Promise<boolean> {
  if (state.isPollInFlight) {
    return false;
  }

  state.isPollInFlight = true;
  try {
    await pollCycle();
    return true;
  } finally {
    state.isPollInFlight = false;
  }
}

/**
 * Creates an interval-backed polling loop with graceful stop semantics.
 *
 * @remarks
 * `stop` clears the interval first and then waits for one in-flight cycle to finish.
 * Repeated stop requests while shutdown is in progress reuse the same promise.
 *
 * @param pollIntervalMs - Interval duration in milliseconds.
 * @param pollCycle - Poll cycle callback to execute on each tick.
 * @param dependencies - Optional interval and logging overrides for tests.
 * @returns Polling loop lifecycle controller.
 */
export function createPollingLoopController(
  pollIntervalMs: number,
  pollCycle: () => Promise<void>,
  dependencies: PollingLoopDependencies = {},
): PollingLoopController {
  const setIntervalFn: NonNullable<PollingLoopDependencies["setIntervalFn"]> =
    dependencies.setIntervalFn ??
    ((callback, delayMs) => setInterval(callback, delayMs) as WorkerPollingTimerHandle);
  const clearIntervalFn: NonNullable<PollingLoopDependencies["clearIntervalFn"]> =
    dependencies.clearIntervalFn ??
    ((timerHandle) => clearInterval(timerHandle as ReturnType<typeof setInterval>));
  const errorLogger = dependencies.logError ?? console.error;

  let timerHandle: WorkerPollingTimerHandle | null = null;
  let inFlightPollPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let isShutdownRequested = false;

  const runPollCycle = (): void => {
    if (isShutdownRequested) {
      return;
    }

    const pendingPollPromise = pollCycle().catch((error) => {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(`[worker] poll cycle failed: ${details}`);
    });
    inFlightPollPromise = pendingPollPromise.finally(() => {
      if (inFlightPollPromise === pendingPollPromise) {
        inFlightPollPromise = null;
      }
    });
  };

  const start = (): void => {
    if (timerHandle !== null || shutdownPromise !== null) {
      return;
    }

    isShutdownRequested = false;
    timerHandle = setIntervalFn(() => {
      runPollCycle();
    }, pollIntervalMs);
  };

  const stop = async (): Promise<void> => {
    if (shutdownPromise !== null) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async () => {
      isShutdownRequested = true;
      if (timerHandle !== null) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }

      if (inFlightPollPromise !== null) {
        await inFlightPollPromise;
      }
    })();

    try {
      await shutdownPromise;
    } finally {
      shutdownPromise = null;
    }
  };

  const isRunning = (): boolean => timerHandle !== null;

  return { start, stop, isRunning };
}

/**
 * Creates a fresh empty processed key tracking state.
 */
export function createProcessedKeyState(): ProcessedKeyState {
  return { keys: new Set(), order: [] };
}

/**
 * Tracks a processed idempotency key while enforcing a fixed-size in-memory cap.
 *
 * @remarks
 * Oldest keys are evicted first once `maxKeys` is exceeded, allowing
 * long-running worker processes to stay memory-bounded.
 *
 * @param key - Idempotency key for a completed job.
 * @param state - Mutable tracking state.
 * @param maxKeys - Maximum number of keys to retain.
 */
export function trackProcessedKey(
  key: string,
  state: ProcessedKeyState,
  maxKeys: number,
): void {
  if (state.keys.has(key)) {
    return;
  }

  state.keys.add(key);
  state.order.push(key);

  while (state.order.length > maxKeys) {
    const evicted = state.order.shift();
    if (evicted) {
      state.keys.delete(evicted);
    }
  }
}

/**
 * Converts rule-engine execution output into a worker job summary.
 *
 * @param job - Original queued job.
 * @param idempotencyKey - Stable job key.
 * @param executionResult - Rule-engine execution output.
 * @param processedAt - ISO timestamp for summary emission.
 * @returns Worker summary payload.
 */
export function buildJobSummary(
  job: AnalyzePullRequestJob,
  idempotencyKey: string,
  executionResult: RuleExecutionResult,
  processedAt: string,
): AnalyzePullRequestJobSummary {
  return {
    jobId: job.job_id,
    idempotencyKey,
    repository: job.repo_full_name,
    pullRequestNumber: job.pr_number,
    headSha: job.head_sha,
    totalFindings: executionResult.summary.totalFindings,
    findingsByCategory: executionResult.summary.findingsByCategory,
    totalRules: executionResult.summary.totalRules,
    successfulRules: executionResult.summary.successfulRules,
    failedRules: executionResult.summary.failedRules,
    failedRuleIds: executionResult.failedRuleIds,
    processedAt,
  };
}

/**
 * Filters rule list based on config include/exclude selectors.
 *
 * @remarks
 * `include` acts as an allowlist when non-empty; `exclude` always removes ids.
 * Output order is stable and follows the original rule order.
 *
 * @param rules - Candidate rules available to the worker.
 * @param mergewiseConfig - Runtime include/exclude settings.
 * @returns Rule list that should be executed.
 */
export function selectRulesForExecution(
  rules: readonly Rule[],
  mergewiseConfig: MergewiseConfig,
): readonly Rule[] {
  const includeSet = new Set(mergewiseConfig.rules.include);
  const excludeSet = new Set(mergewiseConfig.rules.exclude);
  const shouldApplyInclude = includeSet.size > 0;

  return rules.filter((rule) => {
    const ruleId = rule.metadata.ruleId;
    if (excludeSet.has(ruleId)) {
      return false;
    }

    if (!shouldApplyInclude) {
      return true;
    }

    return includeSet.has(ruleId);
  });
}

/**
 * Applies confidence gating to findings.
 *
 * @param executionResult - Rule-engine output before worker gating.
 * @param mergewiseConfig - Runtime gating thresholds/limits used to filter findings by confidence.
 * @returns Execution result with confidence-gated findings and recomputed summary counts.
 */
export function applyFindingGates(
  executionResult: RuleExecutionResult,
  mergewiseConfig: MergewiseConfig,
): RuleExecutionResult {
  const confidenceThreshold = mergewiseConfig.gating.confidenceThreshold;
  const confidenceFilteredFindings = executionResult.findings.filter(
    (finding) => finding.confidence >= confidenceThreshold,
  );
  const sortedFindings = [...confidenceFilteredFindings].sort(compareFindingsForGating);
  const findingsByCategory = {
    clean: 0,
    perf: 0,
    safety: 0,
    idiomatic: 0,
  };

  for (const finding of sortedFindings) {
    findingsByCategory[finding.category] += 1;
  }

  return {
    findings: sortedFindings,
    summary: {
      ...executionResult.summary,
      totalFindings: sortedFindings.length,
      findingsByCategory,
    },
    failedRuleIds: executionResult.failedRuleIds,
  };
}

function compareFindingsForGating(
  leftFinding: {
    readonly confidence: number;
    readonly findingId: string;
    readonly ruleId: string;
    readonly filePath: string;
    readonly line: number;
  },
  rightFinding: {
    readonly confidence: number;
    readonly findingId: string;
    readonly ruleId: string;
    readonly filePath: string;
    readonly line: number;
  },
): number {
  const confidenceDifference = rightFinding.confidence - leftFinding.confidence;
  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  const findingIdComparison = leftFinding.findingId.localeCompare(rightFinding.findingId);
  if (findingIdComparison !== 0) {
    return findingIdComparison;
  }

  const ruleIdComparison = leftFinding.ruleId.localeCompare(rightFinding.ruleId);
  if (ruleIdComparison !== 0) {
    return ruleIdComparison;
  }

  const filePathComparison = leftFinding.filePath.localeCompare(rightFinding.filePath);
  if (filePathComparison !== 0) {
    return filePathComparison;
  }

  return leftFinding.line - rightFinding.line;
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

/**
 * Builds a Markdown pull request comment for one finding with human-readable context and a collapsible structured payload.
 *
 * @param finding - The finding object used to populate rule, location, evidence, recommendation, and payload fields.
 * @param dedupeKey - Unique deduplication key included in the structured payload.
 * @returns The full Markdown comment string posted to the pull request.
 *
 * @remarks
 * Stringifies a subset of finding fields with 2-space indentation, includes evidence and recommendation sections,
 * and embeds the payload inside a collapsible `<details>` block.
 */
function buildStructuredFindingComment(finding: Finding, dedupeKey: string): string {
  const structuredPayload = JSON.stringify(
    {
      dedupeKey,
      findingId: finding.findingId,
      ruleId: finding.ruleId,
      category: finding.category,
      filePath: finding.filePath,
      line: finding.line,
      confidence: finding.confidence,
    },
    null,
    2,
  );

  return [
    "## Mergewise Finding",
    "",
    `- Rule: \`${finding.ruleId}\``,
    `- Category: \`${finding.category}\``,
    `- Location: \`${finding.filePath}:${finding.line}\``,
    `- Confidence: \`${finding.confidence.toFixed(2)}\``,
    "",
    "**Evidence**",
    finding.evidence,
    "",
    "**Recommendation**",
    finding.recommendation,
    "",
    "<details>",
    "<summary>Structured Payload</summary>",
    "",
    "```json",
    structuredPayload,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function resolveGitHubFetchOptions(): WorkerGitHubFetchOptions {
  const config = loadConfig();
  return {
    githubApiBaseUrl: config.githubApiBaseUrl,
    githubUserAgent: config.githubUserAgent,
    githubRequestTimeoutMs: config.githubRequestTimeoutMs,
    githubFetchRetries: config.githubFetchRetries,
    githubRetryDelayMs: config.githubRetryDelayMs,
  };
}

function mapGitHubPullRequestFilesToDiffs(
  githubFiles: readonly GitHubPullRequestFile[],
): readonly FileDiff[] {
  return githubFiles.map((githubFile) => ({
    filePath: githubFile.filename,
    previousPath: null,
    hunks: parsePatchToDiffHunks(githubFile.patch),
  }));
}

function parsePatchToDiffHunks(patch: string | undefined): readonly DiffHunk[] {
  if (!patch) {
    return [];
  }

  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (currentHeader !== null) {
        hunks.push({ header: currentHeader, lines: currentLines });
      }
      currentHeader = line;
      currentLines = [];
      continue;
    }

    if (currentHeader !== null) {
      currentLines.push(line);
    }
  }

  if (currentHeader !== null) {
    hunks.push({ header: currentHeader, lines: currentLines });
  }

  return hunks;
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

function loadGitHubAppCredentials(): Readonly<{ appId: number; privateKeyPem: string }> {
  const appIdRaw = process.env.GITHUB_APP_ID;
  if (!appIdRaw?.trim()) {
    throw new Error("[worker] missing GITHUB_APP_ID");
  }

  const appId = Number.parseInt(appIdRaw, 10);
  if (Number.isNaN(appId) || appId <= 0) {
    throw new Error(`[worker] invalid GITHUB_APP_ID value: ${appIdRaw}`);
  }

  const preferredPrivateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  const legacyPrivateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY_PEM;
  const privateKeyRaw = preferredPrivateKeyRaw ?? legacyPrivateKeyRaw;

  if (privateKeyRaw === undefined) {
    throw new Error(
      "[worker] missing GITHUB_APP_PRIVATE_KEY (or legacy GITHUB_APP_PRIVATE_KEY_PEM)",
    );
  }

  const privateKeyPem = privateKeyRaw.replace(/\\n/g, "\n").trim();
  if (!privateKeyPem) {
    if (preferredPrivateKeyRaw !== undefined) {
      throw new Error("[worker] invalid GITHUB_APP_PRIVATE_KEY value: empty");
    }

    throw new Error("[worker] invalid GITHUB_APP_PRIVATE_KEY_PEM value: empty");
  }

  return { appId, privateKeyPem };
}
