import type { Finding, FindingCategory } from "@mergewise/shared-types";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import { buildStructuredFindingComment } from "./comment-formatter";
import { compareFindingsForGating, type WorkerCheckOutput } from "./job-utils";
import {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
} from "./config";

const SIMILARITY_THRESHOLD = 0.7;
const SAME_FILE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Extracts a normalised set of lowercase words from text.
 *
 * @param text - Input text.
 * @returns Set of lowercase words with punctuation stripped.
 */
function extractWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean),
  );
}

/**
 * Computes Dice coefficient similarity between two texts using word sets.
 *
 * @param textA - First text.
 * @param textB - Second text.
 * @returns Similarity score between 0 and 1.
 */
export function computeTextSimilarity(textA: string, textB: string): number {
  const wordsA = extractWords(textA);
  const wordsB = extractWords(textB);
  if (wordsA.size === 0 && wordsB.size === 0) {
    return 1;
  }
  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersectionCount = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersectionCount += 1;
    }
  }

  return (2 * intersectionCount) / (wordsA.size + wordsB.size);
}

/**
 * Groups findings by category and recommendation similarity.
 *
 * Findings in the same category whose recommendation text exceeds
 * the similarity threshold are merged into a single group. The
 * highest-confidence finding in each group is kept as the representative.
 *
 * @param findings - Deduplicated findings sorted by confidence descending.
 * @returns Deduplicated findings and count of those removed.
 */
function deduplicateBySimilarity(
  findings: readonly Finding[],
): { deduplicated: readonly Finding[]; skippedBySimilarity: number } {
  const categoryGroups = new Map<string, Finding[][]>();

  for (const finding of findings) {
    const groups = categoryGroups.get(finding.category) ?? [];
    let matchedGroup: Finding[] | undefined;

    for (const group of groups) {
      const representative = group[0];
      if (representative && computeTextSimilarity(representative.recommendation, finding.recommendation) >= SIMILARITY_THRESHOLD) {
        matchedGroup = group;
        break;
      }
    }

    if (matchedGroup) {
      matchedGroup.push(finding);
    } else {
      groups.push([finding]);
      categoryGroups.set(finding.category, groups);
    }
  }

  const deduplicated: Finding[] = [];
  let skippedBySimilarity = 0;

  for (const groups of categoryGroups.values()) {
    for (const group of groups) {
      const best = group.reduce((top, current) =>
        current.confidence > top.confidence ? current : top,
      );
      deduplicated.push(best);
      skippedBySimilarity += group.length - 1;
    }
  }

  deduplicated.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return buildFindingDedupeKey(left).localeCompare(buildFindingDedupeKey(right));
  });

  return { deduplicated, skippedBySimilarity };
}

/**
 * Groups findings targeting the same file by recommendation similarity.
 *
 * Uses a lower similarity threshold than the category-level pass to catch
 * near-duplicate findings on different lines of the same function.
 *
 * @param findings - Findings sorted by confidence descending.
 * @returns Deduplicated findings and count of those removed.
 */
function deduplicateBySameFileSimilarity(
  findings: readonly Finding[],
): { deduplicated: readonly Finding[]; skippedBySimilarity: number } {
  const fileGroups = new Map<string, Finding[][]>();

  for (const finding of findings) {
    const groups = fileGroups.get(finding.filePath) ?? [];
    let matchedGroup: Finding[] | undefined;

    for (const group of groups) {
      const representative = group[0];
      if (
        representative &&
        computeTextSimilarity(representative.recommendation, finding.recommendation) >= SAME_FILE_SIMILARITY_THRESHOLD
      ) {
        matchedGroup = group;
        break;
      }
    }

    if (matchedGroup) {
      matchedGroup.push(finding);
    } else {
      groups.push([finding]);
      fileGroups.set(finding.filePath, groups);
    }
  }

  const deduplicated: Finding[] = [];
  let skippedBySimilarity = 0;

  for (const groups of fileGroups.values()) {
    for (const group of groups) {
      const best = group.reduce((top, current) =>
        current.confidence > top.confidence ? current : top,
      );
      deduplicated.push(best);
      skippedBySimilarity += group.length - 1;
    }
  }

  deduplicated.sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return buildFindingDedupeKey(left).localeCompare(buildFindingDedupeKey(right));
  });

  return { deduplicated, skippedBySimilarity };
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
  /**
   * Findings removed by recommendation text similarity deduplication.
   */
  readonly skippedBySimilarity: number;
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
): { groups: readonly Finding[][]; skippedByDeduplication: number; skippedByGrouping: number; skippedByCap: number; skippedBySimilarity: number } {
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

  const { deduplicated: similarityDeduplicated, skippedBySimilarity: skippedByCategorySimilarity } =
    deduplicateBySimilarity(deduplicatedFindings);

  const { deduplicated: fileSimilarityDeduplicated, skippedBySimilarity: skippedByFileSimilarity } =
    deduplicateBySameFileSimilarity(similarityDeduplicated);

  const skippedBySimilarity = skippedByCategorySimilarity + skippedByFileSimilarity;

  const groupedByFileRule = new Map<string, Finding[]>();
  let skippedByGrouping = 0;
  for (const finding of fileSimilarityDeduplicated) {
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
  const skippedByCap = allGroups
    .slice(maxComments)
    .reduce((total, group) => total + group.length, 0);

  return { groups: selectedGroups, skippedByDeduplication, skippedByGrouping, skippedByCap, skippedBySimilarity };
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

  const { groups, skippedByDeduplication, skippedByGrouping, skippedByCap, skippedBySimilarity } =
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
    skippedBySimilarity,
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
    "<details>",
    "<summary>Delivery counters</summary>",
    "",
    `- skipped_by_confidence=${delivery.skippedByConfidence}`,
    `- skipped_by_deduplication=${delivery.skippedByDeduplication}`,
    `- skipped_by_policy=${delivery.skippedByPolicy}`,
    `- skipped_by_similarity=${delivery.skippedBySimilarity}`,
    `- skipped_by_grouping=${delivery.skippedByGrouping}`,
    `- skipped_by_cap=${delivery.skippedByCap}`,
    "",
    "</details>",
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
    return "**Reviewer Summary**\nNo findings selected for reviewer output.";
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

  const summaryLines: string[] = ["**Reviewer Summary**"];
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
