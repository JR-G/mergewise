import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  type FetchPullRequestFilesOptions,
  type GitHubPullRequestFile,
} from "@mergewise/github-client";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

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
}

/**
 * Runtime options for fetching pull request files in the worker.
 */
export interface WorkerGitHubFetchOptions {
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
}

/**
 * Dependency hooks for retryable pull request file fetch.
 */
export interface PullRequestFileRetryDependencies {
  /**
   * GitHub client function for fetching pull request files.
   */
  fetchPullRequestFiles: (
    options: FetchPullRequestFilesOptions,
  ) => Promise<GitHubPullRequestFile[]>;
  /**
   * Async delay function used between retry attempts.
   */
  sleep: (delayMs: number) => Promise<void>;
}

/**
 * Dependency hooks for processing a pull request analysis job.
 */
export interface ProcessAnalyzePullRequestJobDependencies {
  /**
   * GitHub App JWT creation function.
   */
  createGitHubAppJwt: typeof createGitHubAppJwt;
  /**
   * Installation token exchange function.
   */
  exchangeInstallationAccessToken: typeof exchangeInstallationAccessToken;
  /**
   * Retryable pull request file fetch function.
   */
  fetchPullRequestFilesWithRetry: typeof fetchPullRequestFilesWithRetry;
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

  return {
    pollIntervalMs,
    maxProcessedKeys,
    githubApiBaseUrl,
    githubUserAgent,
    githubRequestTimeoutMs,
    githubFetchRetries,
    githubRetryDelayMs,
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

  for (let attemptNumber = 1; attemptNumber <= totalAttempts; attemptNumber += 1) {
    try {
      return await dependencies.fetchPullRequestFiles(options);
    } catch (error) {
      const isLastAttempt = attemptNumber === totalAttempts;
      const isRetryable = isRetryablePullRequestFileFetchError(error);

      if (isLastAttempt || !isRetryable) {
        throw error;
      }

      await dependencies.sleep(retryDelayMs);
    }
  }

  throw new Error("Unreachable: retry loop exited without returning or throwing");
}

/**
 * Processes a queued analysis job.
 *
 * @remarks
 * Returns `true` only when GitHub pull request files are fetched successfully.
 *
 * @param job - Job payload to process.
 * @param options - GitHub fetch runtime options.
 * @param dependencies - External call dependencies for test isolation.
 * @returns Success state for idempotency tracking.
 */
export async function processAnalyzePullRequestJob(
  job: AnalyzePullRequestJob,
  options: WorkerGitHubFetchOptions,
  dependencies: ProcessAnalyzePullRequestJobDependencies = {
    createGitHubAppJwt,
    exchangeInstallationAccessToken,
    fetchPullRequestFilesWithRetry,
  },
): Promise<boolean> {
  const key = buildIdempotencyKey(job);
  console.log(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"}`,
  );

  if (job.installation_id === null) {
    console.error(
      `[worker] skipping job=${job.job_id}: missing installation_id for ${job.repo_full_name}#${job.pr_number}`,
    );
    return false;
  }

  const repositoryCoordinates = parseRepositoryFullName(job.repo_full_name);
  if (!repositoryCoordinates) {
    console.error(
      `[worker] skipping job=${job.job_id}: invalid repo_full_name=${job.repo_full_name}`,
    );
    return false;
  }

  const appCredentials = loadGitHubAppCredentials();
  if (!appCredentials) {
    console.error(
      `[worker] skipping job=${job.job_id}: missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY`,
    );
    return false;
  }

  try {
    const appJwt = dependencies.createGitHubAppJwt(appCredentials);
    const installationAccessToken = await dependencies.exchangeInstallationAccessToken(
      appJwt,
      job.installation_id,
      {
        apiBaseUrl: options.githubApiBaseUrl,
        userAgent: options.githubUserAgent,
        requestTimeoutMs: options.githubRequestTimeoutMs,
      },
    );

    const fetchedFiles = await dependencies.fetchPullRequestFilesWithRetry(
      {
        owner: repositoryCoordinates.owner,
        repository: repositoryCoordinates.repository,
        pullRequestNumber: job.pr_number,
        installationAccessToken: installationAccessToken.token,
        apiBaseUrl: options.githubApiBaseUrl,
        userAgent: options.githubUserAgent,
        requestTimeoutMs: options.githubRequestTimeoutMs,
      },
      options.githubFetchRetries,
      options.githubRetryDelayMs,
    );

    console.log(
      `[worker] fetched ${fetchedFiles.length} files for job=${job.job_id} repo=${job.repo_full_name} pr=${job.pr_number}`,
    );
    return true;
  } catch (error) {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(
      `[worker] failed GitHub fetch for job=${job.job_id} repo=${job.repo_full_name} pr=${job.pr_number}: ${details}`,
    );
    return false;
  }
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

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryablePullRequestFileFetchError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    return error.status === 429 || error.status >= 500;
  }

  if (error instanceof DOMException && error.name === "TimeoutError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return false;
}

function loadGitHubAppCredentials():
  | Readonly<{ appId: number; privateKeyPem: string }>
  | null {
  const appIdRaw = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appIdRaw || !privateKeyRaw) {
    return null;
  }

  const appId = Number.parseInt(appIdRaw, 10);
  if (Number.isNaN(appId) || appId <= 0) {
    return null;
  }

  const privateKeyPem = privateKeyRaw.replace(/\\n/g, "\n").trim();
  if (!privateKeyPem) {
    return null;
  }

  return { appId, privateKeyPem };
}
