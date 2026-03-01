import type {
  AnalyzePullRequestJob,
  FindingCategory,
  Rule,
} from "@mergewise/shared-types";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import type { MergewiseConfig } from "@mergewise/config-loader";

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
   * End-to-end trace identifier stitched from webhook intake to worker processing.
   */
  readonly traceId: string;
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
   * Number of findings skipped due to category/rule post policy.
   */
  readonly skippedByPolicy?: number;
  /**
   * Number of findings skipped because they were grouped into another posted comment.
   */
  readonly skippedByGrouping?: number;
  /**
   * Number of findings removed by recommendation text similarity deduplication.
   */
  readonly skippedBySimilarity?: number;
  /**
   * Structured check output payload for PR status reporting.
   */
  readonly checkOutput?: WorkerCheckOutput;
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
 * Resolves a stable trace identifier for worker job processing logs and API calls.
 *
 * @param job - Pull request analysis job payload.
 * @returns Job-provided trace id, or job id as a backward-compatible fallback.
 */
export function resolveJobTraceId(job: AnalyzePullRequestJob): string {
  const candidateTraceId = job.trace_id?.trim();
  if (candidateTraceId) {
    return candidateTraceId;
  }

  return job.job_id;
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
  const traceId = resolveJobTraceId(job);
  return {
    jobId: job.job_id,
    idempotencyKey,
    repository: job.repo_full_name,
    pullRequestNumber: job.pr_number,
    headSha: job.head_sha,
    traceId,
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
 * Builds a zeroed-out job summary for skipped jobs.
 *
 * @param job - Original queued job.
 * @param traceId - Resolved trace identifier.
 * @param _reason - Skip reason for diagnostics.
 * @returns Worker summary payload with zeroed counters.
 */
export function buildSkippedJobSummary(
  job: AnalyzePullRequestJob,
  traceId: string,
  _reason: string,
  now: () => Date = () => new Date(),
): AnalyzePullRequestJobSummary {
  const key = buildIdempotencyKey(job);
  return {
    jobId: job.job_id,
    idempotencyKey: key,
    repository: job.repo_full_name,
    pullRequestNumber: job.pr_number,
    headSha: job.head_sha,
    traceId,
    totalFindings: 0,
    findingsByCategory: { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
    totalRules: 0,
    successfulRules: 0,
    failedRules: 0,
    failedRuleIds: [],
    processedAt: now().toISOString(),
    postedCommentCount: 0,
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

/**
 * Deterministic comparator for finding ordering within gating and delivery.
 *
 * @param leftFinding - Left-hand finding to compare.
 * @param rightFinding - Right-hand finding to compare.
 * @returns Negative when left sorts first, positive when right sorts first.
 */
export function compareFindingsForGating(
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
