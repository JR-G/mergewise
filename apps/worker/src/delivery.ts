import type { Finding, FindingCategory } from "@mergewise/shared-types";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { buildStructuredFindingComment } from "./comment-formatter";
import { compareFindingsForGating, type WorkerCheckOutput } from "./job-utils";
import {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
} from "./config";

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
  /**
   * Minimum confidence required for test-file findings.
   */
  readonly testFileConfidenceThreshold?: number;
  /**
   * Finding categories eligible for posting.
   */
  readonly allowedCategories?: readonly FindingCategory[];
  /**
   * Rule identifiers excluded from posting.
   */
  readonly blockedRuleIds?: readonly string[];
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
   * Additional grouped findings for the same file/rule pair.
   */
  readonly groupedFindings: readonly Finding[];
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
  /**
   * Findings skipped due to category post policy.
   */
  readonly skippedByPolicy: number;
  /**
   * Findings grouped into an existing file/rule comment.
   */
  readonly skippedByGrouping: number;
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
 * Returns whether a file path points to test-only code.
 *
 * @param filePath - Path to classify.
 * @returns True when path matches common test file conventions.
 */
export function isTestFilePath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();
  return (
    normalizedPath.includes("/__tests__/") ||
    normalizedPath.includes("/__mocks__/") ||
    normalizedPath.includes("/test/") ||
    normalizedPath.includes("/tests/") ||
    normalizedPath.endsWith(".test.js") ||
    normalizedPath.endsWith(".test.jsx") ||
    normalizedPath.endsWith(".test.ts") ||
    normalizedPath.endsWith(".test.tsx") ||
    normalizedPath.endsWith(".spec.js") ||
    normalizedPath.endsWith(".spec.jsx") ||
    normalizedPath.endsWith(".spec.ts") ||
    normalizedPath.endsWith(".spec.tsx")
  );
}

function filterByConfidenceAndPolicy(
  findings: readonly Finding[],
  options: WorkerFindingDeliveryOptions,
): { policyFiltered: readonly Finding[]; skippedByConfidence: number; skippedByPolicy: number } {
  const testFileConfidenceThreshold =
    options.testFileConfidenceThreshold ?? DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD;
  const allowedCategories = options.allowedCategories ?? DEFAULT_ALLOWED_POST_CATEGORIES;
  const blockedRuleIds = options.blockedRuleIds ?? DEFAULT_BLOCKED_POST_RULE_IDS;
  const allowedCategorySet = new Set<FindingCategory>(allowedCategories);
  const blockedRuleIdSet = new Set<string>(blockedRuleIds);
  const skippedByConfidenceCandidates = findings.filter(
    (finding) =>
      finding.confidence < options.confidenceThreshold ||
      (
        isTestFilePath(finding.filePath) &&
        finding.confidence >= options.confidenceThreshold &&
        finding.confidence < testFileConfidenceThreshold
      ),
  );
  const baseConfidencePassing = findings.filter(
    (finding) => finding.confidence >= options.confidenceThreshold,
  );
  const nonTestConfidencePassing = baseConfidencePassing.filter(
    (finding) => !isTestFilePath(finding.filePath),
  );
  const testConfidencePassing = baseConfidencePassing.filter(
    (finding) =>
      isTestFilePath(finding.filePath) &&
      finding.confidence >= testFileConfidenceThreshold,
  );
  const confidencePassing = nonTestConfidencePassing.length > 0
    ? nonTestConfidencePassing
    : testConfidencePassing;
  const policyFiltered = confidencePassing.filter((finding) =>
    allowedCategorySet.has(finding.category) &&
    !blockedRuleIdSet.has(finding.ruleId)
  );
  const skippedByPolicy = confidencePassing.length - policyFiltered.length;

  return {
    policyFiltered,
    skippedByConfidence: skippedByConfidenceCandidates.length,
    skippedByPolicy,
  };
}

function deduplicateAndGroupFindings(
  sortedFindings: readonly Finding[],
  maxComments: number,
): { groups: readonly Finding[][]; skippedByDeduplication: number; skippedByGrouping: number; skippedByCap: number } {
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

  const groupedByFileRule = new Map<string, Finding[]>();
  let skippedByGrouping = 0;
  for (const finding of deduplicatedFindings) {
    const groupKey = `${finding.filePath}:${finding.ruleId}`;
    const groupEntries = groupedByFileRule.get(groupKey);
    if (!groupEntries) {
      groupedByFileRule.set(groupKey, [finding]);
      continue;
    }

    groupEntries.push(finding);
    skippedByGrouping += 1;
  }

  const allGroups = [...groupedByFileRule.values()];
  const selectedGroups = allGroups.slice(0, maxComments);
  const skippedByCap = Math.max(allGroups.length - selectedGroups.length, 0);

  return { groups: selectedGroups, skippedByDeduplication, skippedByGrouping, skippedByCap };
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
  const { policyFiltered, skippedByConfidence, skippedByPolicy } =
    filterByConfidenceAndPolicy(findings, options);

  const sortedFindings = [...policyFiltered].sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }

    const leftKey = buildFindingDedupeKey(left);
    const rightKey = buildFindingDedupeKey(right);
    return leftKey.localeCompare(rightKey);
  });

  const { groups, skippedByDeduplication, skippedByGrouping, skippedByCap } =
    deduplicateAndGroupFindings(sortedFindings, options.maxComments);

  const comments = groups.flatMap((group) => {
    const primaryFinding = group[0];
    if (!primaryFinding) return [];
    const dedupeKey = buildFindingDedupeKey(primaryFinding);
    return {
      dedupeKey,
      finding: primaryFinding,
      groupedFindings: group,
      body: buildStructuredFindingComment(primaryFinding, group, dedupeKey),
    };
  });

  return {
    comments,
    skippedByConfidence,
    skippedByDeduplication,
    skippedByPolicy,
    skippedByGrouping,
    skippedByCap,
  };
}

/**
 * Builds structured check output from delivery and execution summaries.
 *
 * @param executionResult - Rule execution result.
 * @param delivery - Prepared delivery output.
 * @param postedCount - Number of comments that were actually posted.
 * @param reviewerSummaryOptions - Optional reviewer summary options for evidence links.
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
    `- skipped_by_policy=${delivery.skippedByPolicy}`,
    `- skipped_by_grouping=${delivery.skippedByGrouping}`,
    `- skipped_by_cap=${delivery.skippedByCap}`,
  ].join("\n");

  const title = postedCount > 0
    ? `Review completed — ${postedCount} comment${postedCount === 1 ? "" : "s"}`
    : "Review completed";

  return {
    title,
    summary:
      `Rules=${executionResult.summary.successfulRules}/${executionResult.summary.totalRules}` +
      ` findings=${totalFindings} posted=${postedCount}`,
    text: `${reviewerSummaryMarkdown}\n\n${deliveryCounterMarkdown}`,
  };
}

export function buildReviewerSummaryMarkdown(
  comments: readonly PreparedFindingComment[],
  options?: WorkerReviewerSummaryOptions,
): string {
  if (comments.length === 0) {
    return "### Reviewer Summary\nNo findings selected for reviewer output.";
  }

  const groupedByCategory = new Map<FindingCategory, Map<string, Finding[]>>();
  for (const preparedComment of comments) {
    for (const finding of preparedComment.groupedFindings) {
      const groupedByRule = groupedByCategory.get(finding.category) ?? new Map<string, Finding[]>();
      const findingsForRule = groupedByRule.get(finding.ruleId) ?? [];
      groupedByRule.set(finding.ruleId, [...findingsForRule, finding]);
      groupedByCategory.set(finding.category, groupedByRule);
    }
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

export function formatEvidenceLinksForRule(
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

export function formatEvidenceLocationLink(
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
