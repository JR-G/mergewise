import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
} from "@mergewise/github-client";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { executeRules } from "@mergewise/rule-engine";
import { tsReactRules } from "@mergewise/rule-ts-react";
import type {
  AnalysisContext,
  AnalyzePullRequestJob,
  DiffHunk,
  FileDiff,
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

  if (Number.isNaN(pollIntervalMs) || pollIntervalMs < 250) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS value: ${pollRaw}`);
  }

  if (Number.isNaN(maxProcessedKeys) || maxProcessedKeys < 100) {
    throw new Error(`Invalid WORKER_MAX_PROCESSED_KEYS value: ${maxKeysRaw}`);
  }

  return { pollIntervalMs, maxProcessedKeys };
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
   * Info logger for operational events.
   */
  readonly logInfo?: (message: string) => void;
  /**
   * Error logger for rule failures.
   */
  readonly logError?: (message: string) => void;
  /**
   * Analysis context loader override for testing.
   */
  readonly loadAnalysisContextFn?: (
    job: AnalyzePullRequestJob,
  ) => Promise<AnalysisContext>;
}

/**
 * Dependency overrides for analysis context loading.
 */
export interface AnalysisContextLoadingDependencies {
  /**
   * JWT creation override for tests.
   */
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  /**
   * Installation token exchange override for tests.
   */
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  /**
   * Pull request files fetch override for tests.
   */
  readonly fetchPullRequestFilesFn?: typeof fetchPullRequestFiles;
  /**
   * Environment source override for tests.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * GitHub API settings required for worker-side pull request file loading.
 */
export interface GitHubWorkerApiConfig {
  /**
   * GitHub App identifier.
   */
  readonly appId: number;
  /**
   * PEM-encoded GitHub App private key.
   */
  readonly privateKeyPem: string;
  /**
   * Optional API base URL override.
   */
  readonly apiBaseUrl?: string;
  /**
   * Optional request timeout override in milliseconds.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Optional user agent override.
   */
  readonly userAgent?: string;
}

/**
 * Processes a queued analysis job through rule execution and summary generation.
 *
 * @param job - Job payload to process.
 * @param dependencies - Optional dependency overrides.
 * @returns Deterministic processing summary, or `null` when the job is skipped after a recoverable failure.
 */
export async function processAnalyzePullRequestJob(
  job: AnalyzePullRequestJob,
  dependencies: WorkerProcessingDependencies = {},
): Promise<AnalyzePullRequestJobSummary | null> {
  const key = buildIdempotencyKey(job);
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;
  const rules = dependencies.rules ?? tsReactRules;
  const executeRulesFn = dependencies.executeRulesFn ?? executeRules;
  const loadAnalysisContextFn =
    dependencies.loadAnalysisContextFn ?? loadAnalysisContextForJob;

  infoLogger(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"} rules=${rules.length}`,
  );

  let analysisContext: AnalysisContext;
  try {
    analysisContext = await loadAnalysisContextFn(job);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    errorLogger(`[worker] failed to load analysis context job=${job.job_id}: ${detail}`);
    return null;
  }

  let executionResult: RuleExecutionResult;
  try {
    executionResult = await executeRulesFn({
      context: analysisContext,
      rules,
      onRuleExecutionError: (rule, error) => {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        errorLogger(
          `[worker] rule failure job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
        );
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    errorLogger(`[worker] failed to execute rules job=${job.job_id}: ${detail}`);
    return null;
  }

  const processedAt = new Date().toISOString();
  const summary = buildJobSummary(job, key, executionResult, processedAt);
  infoLogger(
    `[worker] summary job=${summary.jobId} findings=${summary.totalFindings} rules_ok=${summary.successfulRules}/${summary.totalRules}`,
  );

  return summary;
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
 * Mutable state tracking whether one poll cycle is currently active.
 */
export interface PollCycleState {
  /**
   * Indicates whether poll execution is currently in flight.
   */
  isPollInFlight: boolean;
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
 * Loads pull request diffs from GitHub and builds analysis context.
 *
 * @param job - Job payload.
 * @param dependencies - Optional dependency overrides.
 * @returns Rule-engine analysis context.
 */
export async function loadAnalysisContextForJob(
  job: AnalyzePullRequestJob,
  dependencies: AnalysisContextLoadingDependencies = {},
): Promise<AnalysisContext> {
  if (job.installation_id === null) {
    throw new Error(
      `Unable to load PR diffs for job=${job.job_id}: installation_id is required.`,
    );
  }

  const repositoryCoordinates = parseRepositoryFullName(job.repo_full_name);
  const githubConfig = loadGitHubWorkerApiConfig(dependencies.env ?? process.env);
  const createGitHubAppJwtFn =
    dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
  const exchangeInstallationAccessTokenFn =
    dependencies.exchangeInstallationAccessTokenFn ??
    exchangeInstallationAccessToken;
  const fetchPullRequestFilesFn =
    dependencies.fetchPullRequestFilesFn ?? fetchPullRequestFiles;

  const appJwt = createGitHubAppJwtFn({
    appId: githubConfig.appId,
    privateKeyPem: githubConfig.privateKeyPem,
  });
  const installationToken = await exchangeInstallationAccessTokenFn(
    appJwt,
    job.installation_id,
    {
      apiBaseUrl: githubConfig.apiBaseUrl,
      requestTimeoutMs: githubConfig.requestTimeoutMs,
      userAgent: githubConfig.userAgent,
    },
  );
  const pullRequestFiles = await fetchPullRequestFilesFn({
    owner: repositoryCoordinates.owner,
    repository: repositoryCoordinates.repository,
    pullRequestNumber: job.pr_number,
    installationAccessToken: installationToken.token,
    apiBaseUrl: githubConfig.apiBaseUrl,
    requestTimeoutMs: githubConfig.requestTimeoutMs,
    userAgent: githubConfig.userAgent,
  });
  const diffs = pullRequestFiles.map((file) =>
    mapGitHubPullRequestFileToDiff(file),
  );

  return buildAnalysisContext(job, diffs);
}

/**
 * Builds rule-engine analysis context from a queued webhook job and diff payload.
 *
 * @param job - Job payload.
 * @param diffs - Parsed file diffs for the pull request.
 * @returns Rule-engine analysis context.
 */
export function buildAnalysisContext(
  job: AnalyzePullRequestJob,
  diffs: readonly FileDiff[],
): AnalysisContext {
  return {
    diffs,
    pullRequest: {
      repo: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      installationId: job.installation_id,
    },
  };
}

type RepositoryCoordinates = {
  owner: string;
  repository: string;
};

type GitHubPullRequestFileWithRename = {
  filename: string;
  status: string;
  patch?: string;
  previous_filename?: string;
};

function parseRepositoryFullName(repoFullName: string): RepositoryCoordinates {
  const separatorIndex = repoFullName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex >= repoFullName.length - 1) {
    throw new Error(
      `Invalid repo_full_name format: ${repoFullName}. Expected owner/name.`,
    );
  }

  return {
    owner: repoFullName.slice(0, separatorIndex),
    repository: repoFullName.slice(separatorIndex + 1),
  };
}

function loadGitHubWorkerApiConfig(env: NodeJS.ProcessEnv): GitHubWorkerApiConfig {
  const appIdRaw = env.GITHUB_APP_ID;
  if (!appIdRaw) {
    throw new Error("Missing GITHUB_APP_ID for worker GitHub API access.");
  }

  const appId = Number.parseInt(appIdRaw, 10);
  if (Number.isNaN(appId) || appId <= 0) {
    throw new Error(`Invalid GITHUB_APP_ID value: ${appIdRaw}`);
  }

  const privateKeyRaw = env.GITHUB_APP_PRIVATE_KEY_PEM;
  if (!privateKeyRaw) {
    throw new Error(
      "Missing GITHUB_APP_PRIVATE_KEY_PEM for worker GitHub API access.",
    );
  }

  const requestTimeoutRaw = env.GITHUB_API_REQUEST_TIMEOUT_MS;
  let requestTimeoutMs: number | undefined;
  if (requestTimeoutRaw !== undefined) {
    const parsedTimeout = Number.parseInt(requestTimeoutRaw, 10);
    if (Number.isNaN(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`Invalid GITHUB_API_REQUEST_TIMEOUT_MS value: ${requestTimeoutRaw}`);
    }
    requestTimeoutMs = parsedTimeout;
  }

  return {
    appId,
    privateKeyPem: privateKeyRaw.replace(/\\n/g, "\n"),
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    requestTimeoutMs,
    userAgent: env.GITHUB_API_USER_AGENT,
  };
}

function mapGitHubPullRequestFileToDiff(
  file: GitHubPullRequestFileWithRename,
): FileDiff {
  return {
    filePath: file.filename,
    previousPath:
      file.status === "renamed" ? file.previous_filename ?? null : null,
    hunks: parseDiffHunksFromPatch(file.patch),
  };
}

function parseDiffHunksFromPatch(patch: string | undefined): readonly DiffHunk[] {
  if (!patch) {
    return [];
  }

  const parsedHunks: DiffHunk[] = [];
  const patchLines = patch.split("\n");
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const patchLine of patchLines) {
    if (patchLine.startsWith("@@")) {
      if (currentHeader !== null) {
        parsedHunks.push({
          header: currentHeader,
          lines: currentLines,
        });
      }
      currentHeader = patchLine;
      currentLines = [];
      continue;
    }

    if (currentHeader === null) {
      continue;
    }

    if (
      patchLine.startsWith("+") ||
      patchLine.startsWith("-") ||
      patchLine.startsWith(" ")
    ) {
      currentLines.push(patchLine);
    }
  }

  if (currentHeader !== null) {
    parsedHunks.push({
      header: currentHeader,
      lines: currentLines,
    });
  }

  return parsedHunks;
}

/**
 * Converts rule-engine execution output into a worker job summary.
 *
 * @param job - Original queued job.
 * @param idempotencyKey - Stable job key.
 * @param executionResult - Rule-engine execution output.
 * @param processedAt - Precomputed processing completion timestamp.
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
