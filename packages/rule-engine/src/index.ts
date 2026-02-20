import type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  DiffHunk,
  FileDiff,
  Finding,
  FindingCategory,
  FindingStatus,
  PatchPreview,
  PatchSuggestionPolicy,
  PullRequestMetadata,
  Rule,
  RuleMetadata,
  StatelessRule,
  SymbolEntry,
} from "@mergewise/shared-types";

export { goFmtPrintRule, goPilotRules } from "./go";

const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "clean",
  "perf",
  "safety",
  "idiomatic",
];

/**
 * Callback invoked when one rule fails during execution.
 *
 * @param rule - Rule that failed.
 * @param error - Thrown error value.
 */
export type OnRuleExecutionError = (rule: Rule, error: unknown) => void;

/**
 * Input parameters for the rule runner.
 */
export interface ExecuteRulesOptions {
  /**
   * Parsed analysis context for the target pull request.
   */
  readonly context: AnalysisContext;
  /**
   * Rules to execute.
   */
  readonly rules: readonly Rule[];
  /**
   * Optional codebase context used by codebase-aware rules.
   */
  readonly codebaseContext?: CodebaseContext;
  /**
   * Optional callback invoked for each rule failure.
   */
  readonly onRuleExecutionError?: OnRuleExecutionError;
}

/**
 * Aggregated execution summary for one runner invocation.
 */
export interface RuleExecutionSummary {
  /**
   * Number of rules requested for execution.
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
   * Total count of findings emitted by successful rules.
   */
  readonly totalFindings: number;
  /**
   * Finding counts grouped by category.
   */
  readonly findingsByCategory: Readonly<Record<FindingCategory, number>>;
}

/**
 * Full result for one runner invocation.
 */
export interface RuleExecutionResult {
  /**
   * Findings emitted by successful rules.
   */
  readonly findings: readonly Finding[];
  /**
   * Execution summary derived from the findings and failures.
   */
  readonly summary: RuleExecutionSummary;
  /**
   * Rule identifiers for rules that failed during execution.
   */
  readonly failedRuleIds: readonly string[];
}

/**
 * Executes rules against one analysis context with per-rule failure isolation.
 *
 * @param options - Runner options.
 * @returns Findings and deterministic execution summary.
 */
export async function executeRules(
  options: ExecuteRulesOptions,
): Promise<RuleExecutionResult> {
  const findings: Finding[] = [];
  const failedRuleIds: string[] = [];
  const onRuleExecutionError =
    options.onRuleExecutionError ?? defaultOnRuleExecutionError;

  for (const rule of options.rules) {
    try {
      const ruleFindings = await executeSingleRule(
        rule,
        options.context,
        options.codebaseContext,
      );
      const validatedFindings = ruleFindings.map((finding) =>
        enforcePatchSuggestionPolicy(finding)
      );
      findings.push(...validatedFindings);
    } catch (error) {
      failedRuleIds.push(rule.metadata.ruleId);
      onRuleExecutionError(rule, error);
    }
  }

  const findingsByCategory = createFindingCategoryMap(findings);
  const summary: RuleExecutionSummary = {
    totalRules: options.rules.length,
    successfulRules: options.rules.length - failedRuleIds.length,
    failedRules: failedRuleIds.length,
    totalFindings: findings.length,
    findingsByCategory,
  };

  return {
    findings,
    summary,
    failedRuleIds,
  };
}

function defaultOnRuleExecutionError(rule: Rule, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[rule-engine] rule failed: ${rule.metadata.ruleId}: ${detail}`);
}

async function executeSingleRule(
  rule: Rule,
  context: AnalysisContext,
  codebaseContext: CodebaseContext | undefined,
): Promise<readonly Finding[]> {
  if (rule.kind === "codebase-aware") {
    if (!codebaseContext) {
      throw new Error(
        `Rule ${rule.metadata.ruleId} requires codebaseContext but none was provided.`,
      );
    }
    return rule.analyse(context, codebaseContext);
  }

  return rule.analyse(context);
}

function enforcePatchSuggestionPolicy(finding: Finding): Finding {
  const patchSuggestionPolicy =
    finding.patchSuggestionPolicy ?? derivePatchSuggestionPolicy(finding.patchPreview);

  if (patchSuggestionPolicy === "manual-only" && finding.patchPreview) {
    throw new Error(
      `Finding ${finding.findingId} has patchSuggestionPolicy=manual-only but includes patchPreview.`,
    );
  }

  if (patchSuggestionPolicy === "safe-patch" && !finding.patchPreview) {
    throw new Error(
      `Finding ${finding.findingId} has patchSuggestionPolicy=safe-patch but patchPreview is missing.`,
    );
  }

  return {
    ...finding,
    patchSuggestionPolicy,
  };
}

function derivePatchSuggestionPolicy(
  patchPreview: PatchPreview | undefined,
): PatchSuggestionPolicy {
  if (patchPreview) {
    return "safe-patch";
  }

  return "manual-only";
}

function createFindingCategoryMap(
  findings: readonly Finding[],
): Readonly<Record<FindingCategory, number>> {
  const counts: Record<FindingCategory, number> = {
    clean: 0,
    perf: 0,
    safety: 0,
    idiomatic: 0,
  };

  for (const finding of findings) {
    counts[finding.category] += 1;
  }

  const categoryMap = FINDING_CATEGORIES.reduce<Record<FindingCategory, number>>(
    (result, category) => ({ ...result, [category]: counts[category] }),
    { clean: 0, perf: 0, safety: 0, idiomatic: 0 },
  );

  return categoryMap;
}

export type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  DiffHunk,
  FileDiff,
  Finding,
  FindingCategory,
  FindingStatus,
  PatchSuggestionPolicy,
  PatchPreview,
  PullRequestMetadata,
  Rule,
  RuleMetadata,
  StatelessRule,
  SymbolEntry,
};
