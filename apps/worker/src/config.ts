import type { FindingCategory } from "@mergewise/shared-types";

export const DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD = 0.98;
export const DEFAULT_ALLOWED_POST_CATEGORIES: readonly FindingCategory[] = [
  "safety",
  "perf",
  "idiomatic",
  "clean",
];
export const DEFAULT_BLOCKED_POST_RULE_IDS: readonly string[] = [
  "ts-react/no-non-null-assertion",
];

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
  /**
   * Minimum confidence required for test-file findings to be eligible for posting.
   */
  testFileConfidenceThreshold: number;
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
 * Loads worker runtime configuration from environment variables.
 *
 * @returns Validated worker configuration.
 */
export function loadConfig(): WorkerConfig {
  const pollRaw = process.env["WORKER_POLL_INTERVAL_MS"] ?? "3000";
  const pollIntervalMs = Number(pollRaw);
  const maxKeysRaw = process.env["WORKER_MAX_PROCESSED_KEYS"] ?? "10000";
  const maxProcessedKeys = Number(maxKeysRaw);
  const githubApiBaseUrl = process.env["GITHUB_API_BASE_URL"] ?? "https://api.github.com";
  const githubUserAgent = process.env["WORKER_GITHUB_USER_AGENT"] ?? "mergewise-worker";
  const timeoutRaw = process.env["WORKER_GITHUB_REQUEST_TIMEOUT_MS"] ?? "10000";
  const githubRequestTimeoutMs = Number(timeoutRaw);
  const retriesRaw = process.env["WORKER_GITHUB_FETCH_RETRIES"] ?? "2";
  const githubFetchRetries = Number(retriesRaw);
  const retryDelayRaw = process.env["WORKER_GITHUB_RETRY_DELAY_MS"] ?? "250";
  const githubRetryDelayMs = Number(retryDelayRaw);
  const confidenceThresholdRaw =
    process.env["WORKER_FINDING_CONFIDENCE_THRESHOLD"] ?? "0.78";
  const confidenceThreshold = Number(confidenceThresholdRaw);
  const maxCommentsRaw = process.env["WORKER_FINDING_MAX_COMMENTS"] ?? "5";
  const maxComments = Number(maxCommentsRaw);
  const testFileConfidenceThresholdRaw =
    process.env["WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD"] ??
    String(DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD);
  const testFileConfidenceThreshold = Number(testFileConfidenceThresholdRaw);

  validateConfig({
    pollIntervalMs, pollRaw,
    maxProcessedKeys, maxKeysRaw,
    githubApiBaseUrl, githubUserAgent,
    githubRequestTimeoutMs, timeoutRaw,
    githubFetchRetries, retriesRaw,
    githubRetryDelayMs, retryDelayRaw,
    confidenceThreshold, confidenceThresholdRaw,
    maxComments, maxCommentsRaw,
    testFileConfidenceThreshold, testFileConfidenceThresholdRaw,
  });

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
    testFileConfidenceThreshold,
  };
}

function validateConfig(values: {
  pollIntervalMs: number; pollRaw: string;
  maxProcessedKeys: number; maxKeysRaw: string;
  githubApiBaseUrl: string; githubUserAgent: string;
  githubRequestTimeoutMs: number; timeoutRaw: string;
  githubFetchRetries: number; retriesRaw: string;
  githubRetryDelayMs: number; retryDelayRaw: string;
  confidenceThreshold: number; confidenceThresholdRaw: string;
  maxComments: number; maxCommentsRaw: string;
  testFileConfidenceThreshold: number; testFileConfidenceThresholdRaw: string;
}): void {
  if (!Number.isFinite(values.pollIntervalMs) || !Number.isInteger(values.pollIntervalMs) || values.pollIntervalMs < 250) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS value: ${values.pollRaw}`);
  }

  if (!Number.isFinite(values.maxProcessedKeys) || !Number.isInteger(values.maxProcessedKeys) || values.maxProcessedKeys < 100) {
    throw new Error(`Invalid WORKER_MAX_PROCESSED_KEYS value: ${values.maxKeysRaw}`);
  }

  if (!values.githubApiBaseUrl.trim()) {
    throw new Error("Invalid GITHUB_API_BASE_URL value: empty");
  }

  if (!values.githubUserAgent.trim()) {
    throw new Error("Invalid WORKER_GITHUB_USER_AGENT value: empty");
  }

  if (!Number.isFinite(values.githubRequestTimeoutMs) || !Number.isInteger(values.githubRequestTimeoutMs) || values.githubRequestTimeoutMs < 100) {
    throw new Error(`Invalid WORKER_GITHUB_REQUEST_TIMEOUT_MS value: ${values.timeoutRaw}`);
  }

  if (!Number.isFinite(values.githubFetchRetries) || !Number.isInteger(values.githubFetchRetries) || values.githubFetchRetries < 0) {
    throw new Error(`Invalid WORKER_GITHUB_FETCH_RETRIES value: ${values.retriesRaw}`);
  }

  if (!Number.isFinite(values.githubRetryDelayMs) || !Number.isInteger(values.githubRetryDelayMs) || values.githubRetryDelayMs < 10) {
    throw new Error(`Invalid WORKER_GITHUB_RETRY_DELAY_MS value: ${values.retryDelayRaw}`);
  }

  if (
    !Number.isFinite(values.confidenceThreshold) ||
    values.confidenceThreshold < 0 ||
    values.confidenceThreshold > 1
  ) {
    throw new Error(
      `Invalid WORKER_FINDING_CONFIDENCE_THRESHOLD value: ${values.confidenceThresholdRaw}`,
    );
  }

  if (!Number.isFinite(values.maxComments) || !Number.isInteger(values.maxComments) || values.maxComments < 1) {
    throw new Error(`Invalid WORKER_FINDING_MAX_COMMENTS value: ${values.maxCommentsRaw}`);
  }
  if (
    !Number.isFinite(values.testFileConfidenceThreshold) ||
    values.testFileConfidenceThreshold < 0 ||
    values.testFileConfidenceThreshold > 1
  ) {
    throw new Error(
      "Invalid WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD value: " +
        values.testFileConfidenceThresholdRaw,
    );
  }
}

/**
 * Extracts the GitHub fetch options subset from the full worker config.
 *
 * @returns GitHub fetch options loaded from environment.
 */
export function resolveGitHubFetchOptions(): WorkerGitHubFetchOptions {
  const config = loadConfig();
  return {
    githubApiBaseUrl: config.githubApiBaseUrl,
    githubUserAgent: config.githubUserAgent,
    githubRequestTimeoutMs: config.githubRequestTimeoutMs,
    githubFetchRetries: config.githubFetchRetries,
    githubRetryDelayMs: config.githubRetryDelayMs,
  };
}
