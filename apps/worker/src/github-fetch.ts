import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  type FetchPullRequestFilesOptions,
  type GitHubPullRequestFile,
} from "@mergewise/github-client";
import type { AnalysisContext, AnalyzePullRequestJob } from "@mergewise/shared-types";
import type { WorkerGitHubFetchOptions } from "./config";
import {
  buildAnalysisContext,
  mapGitHubPullRequestFilesToDiffs,
} from "./diff-parser";
import { loadGitHubAppCredentials } from "./github-auth";
import { parseRepositoryFullName } from "./job-utils";

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
 * Result of building analysis context from GitHub data.
 */
export interface GitHubAnalysisContextResult {
  readonly analysisContext: AnalysisContext;
  readonly owner: string;
  readonly repository: string;
  readonly installationAccessToken: string;
}

/**
 * Dependencies for building analysis context from GitHub.
 */
export interface BuildAnalysisContextDependencies {
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  readonly fetchPullRequestFilesWithRetryFn?: typeof fetchPullRequestFilesWithRetry;
  readonly logWarn?: (message: string) => void;
  readonly logInfo?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

/**
 * Fetches pull request data from GitHub and builds an analysis context.
 *
 * @param job - The analysis job to process.
 * @param githubFetchOptions - Resolved GitHub API options.
 * @param dependencies - Optional dependency overrides for testing.
 * @returns Analysis context with owner, repository, and access token.
 */
export async function buildAnalysisContextFromGitHub(
  job: AnalyzePullRequestJob,
  githubFetchOptions: WorkerGitHubFetchOptions,
  dependencies: BuildAnalysisContextDependencies,
): Promise<GitHubAnalysisContextResult> {
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

export function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function isRetryablePullRequestFileFetchError(error: unknown): boolean {
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
