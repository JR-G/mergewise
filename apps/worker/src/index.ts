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
 * @returns Structured check output payload.
 */
export function buildWorkerCheckOutput(
  executionResult: RuleExecutionResult,
  delivery: PreparedFindingDelivery,
): WorkerCheckOutput {
  const postedCount = delivery.comments.length;
  const totalFindings = executionResult.summary.totalFindings;
  return {
    title: `Mergewise Findings (${postedCount} posted of ${totalFindings})`,
    summary:
      `Rules=${executionResult.summary.successfulRules}/${executionResult.summary.totalRules}` +
      ` findings=${totalFindings} posted=${postedCount}`,
    text:
      `skipped_by_confidence=${delivery.skippedByConfidence}\n` +
      `skipped_by_deduplication=${delivery.skippedByDeduplication}\n` +
      `skipped_by_cap=${delivery.skippedByCap}`,
  };
}

/**
 * Posts prepared finding comments to a pull request.
 *
 * @param options - Repository coordinates, token, and prepared comments.
 * @param dependencies - API posting dependency override.
 * @returns Number of posted comments.
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
): Promise<number> {
  const postPullRequestSummaryCommentFn =
    dependencies.postPullRequestSummaryCommentFn ?? postPullRequestSummaryComment;

  let postedCount = 0;
  for (const preparedComment of options.comments) {
    await postPullRequestSummaryCommentFn({
      owner: options.owner,
      repository: options.repository,
      pullRequestNumber: options.pullRequestNumber,
      installationAccessToken: options.installationAccessToken,
      body: preparedComment.body,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    });
    postedCount += 1;
  }

  return postedCount;
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
  const executeRulesFn = dependencies.executeRulesFn ?? executeRules;
  const githubFetchOptions = dependencies.githubFetchOptions ?? resolveGitHubFetchOptions();
  const findingDeliveryOptions = dependencies.findingDeliveryOptions ?? {
    confidenceThreshold: 0.78,
    maxComments: 20,
  };

  infoLogger(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"} rules=${rules.length}`,
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
    rules,
    onRuleExecutionError: (rule, error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(
        `[worker] rule failure job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
      );
    },
  });

  const delivery = prepareFindingDelivery(executionResult.findings, findingDeliveryOptions);
  const checkOutput = buildWorkerCheckOutput(executionResult, delivery);

  let postedCommentCount = 0;
  if (dependencies.deliveryMode === "github" && delivery.comments.length > 0) {
    postedCommentCount = await postPreparedFindingComments(
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
  }

  const summary = buildJobSummary(
    job,
    key,
    executionResult,
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
