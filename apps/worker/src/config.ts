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
  const githubApiBaseUrl = process.env["GITHUB_API_BASE_URL"] ?? "https://api.github.com";
  const githubUserAgent = process.env["WORKER_GITHUB_USER_AGENT"] ?? "mergewise-worker";

  const pollIntervalMs = parseEnvInt("WORKER_POLL_INTERVAL_MS", 3000, 250);
  const maxProcessedKeys = parseEnvInt("WORKER_MAX_PROCESSED_KEYS", 10000, 100);
  const githubRequestTimeoutMs = parseEnvInt("WORKER_GITHUB_REQUEST_TIMEOUT_MS", 10000, 100);
  const githubFetchRetries = parseEnvInt("WORKER_GITHUB_FETCH_RETRIES", 2, 0);
  const githubRetryDelayMs = parseEnvInt("WORKER_GITHUB_RETRY_DELAY_MS", 250, 10);
  const maxComments = parseEnvInt("WORKER_FINDING_MAX_COMMENTS", 5, 1);
  const confidenceThreshold = parseEnvFloat("WORKER_FINDING_CONFIDENCE_THRESHOLD", 0.78, 0, 1);
  const testFileConfidenceThreshold = parseEnvFloat(
    "WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD",
    DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
    0,
    1,
  );

  if (!githubApiBaseUrl.trim()) {
    throw new Error("Invalid GITHUB_API_BASE_URL value: empty");
  }
  if (!githubUserAgent.trim()) {
    throw new Error("Invalid WORKER_GITHUB_USER_AGENT value: empty");
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
    testFileConfidenceThreshold,
  };
}

function parseEnvInt(envKey: string, fallback: number, minimum: number): number {
  const raw = process.env[envKey] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`Invalid ${envKey} value: ${raw}`);
  }
  return value;
}

function parseEnvFloat(envKey: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[envKey] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${envKey} value: ${raw}`);
  }
  return value;
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
