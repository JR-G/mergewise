import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { executeRules } from "@mergewise/rule-engine";
import { tsReactRules } from "@mergewise/rule-ts-react";
import type {
  AnalysisContext,
  AnalyzePullRequestJob,
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
}

/**
 * Processes a queued analysis job through rule execution and summary generation.
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
  const rules = dependencies.rules ?? tsReactRules;
  const executeRulesFn = dependencies.executeRulesFn ?? executeRules;
  const analysisContext = buildAnalysisContext(job);

  infoLogger(
    `[worker] processing job=${job.job_id} key=${key} installation=${job.installation_id ?? "none"} rules=${rules.length}`,
  );

  const executionResult = await executeRulesFn({
    context: analysisContext,
    rules,
    onRuleExecutionError: (rule, error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(
        `[worker] rule failure job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
      );
    },
  });

  const summary = buildJobSummary(job, key, executionResult);
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
 * Builds rule-engine analysis context from a queued webhook job.
 *
 * @param job - Job payload.
 * @returns Rule-engine analysis context.
 */
export function buildAnalysisContext(job: AnalyzePullRequestJob): AnalysisContext {
  return {
    diffs: [],
    pullRequest: {
      repo: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      installationId: job.installation_id,
    },
  };
}

/**
 * Converts rule-engine execution output into a worker job summary.
 *
 * @param job - Original queued job.
 * @param idempotencyKey - Stable job key.
 * @param executionResult - Rule-engine execution output.
 * @returns Worker summary payload.
 */
export function buildJobSummary(
  job: AnalyzePullRequestJob,
  idempotencyKey: string,
  executionResult: RuleExecutionResult,
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
    processedAt: new Date().toISOString(),
  };
}
