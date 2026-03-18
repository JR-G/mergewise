import type {
  FileDiff,
  Finding,
  FindingCategory,
  PatchPreview,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import { toConfidence, toLineNumber, toRuleId } from "@mergewise/shared-types";
import { ANTI_PATTERNS } from "./anti-patterns";

const VALID_CATEGORIES = new Set<FindingCategory>([
  "clean",
  "perf",
  "safety",
  "idiomatic",
]) satisfies ReadonlySet<FindingCategory>;

/**
 * Maps known principle strings to their correct finding category.
 *
 * @remarks
 * Built from the anti-pattern catalogue at module load. Standard design
 * principles not in the catalogue (SOLID, DRY, KISS, YAGNI) are mapped
 * to their conventional category as fallbacks.
 */
export const PRINCIPLE_CATEGORY_MAP: ReadonlyMap<string, FindingCategory> = buildPrincipleCategoryMap();

function buildPrincipleCategoryMap(): Map<string, FindingCategory> {
  const map = new Map<string, FindingCategory>();

  for (const pattern of ANTI_PATTERNS) {
    map.set(pattern.principle, pattern.category);
  }

  const solidFallbacks: readonly string[] = [
    "SRP", "OCP", "LSP", "ISP", "DIP", "KISS", "YAGNI", "DRY",
  ];
  for (const principle of solidFallbacks) {
    if (!map.has(principle)) {
      map.set(principle, "clean");
    }
  }

  return map;
}

/**
 * Raw finding shape expected from the LLM response.
 */
export interface RawLlmFinding {
  readonly line: number;
  readonly category: string;
  readonly principle: string;
  readonly confidence: number;
  readonly evidence: string;
  readonly recommendation: string;
  readonly suggestedRewrite?: string;
}

/**
 * Parsed LLM response envelope.
 */
interface LlmResponse {
  readonly findings: readonly RawLlmFinding[];
}

/**
 * Extracts the set of added line numbers from a file diff.
 *
 * @param diff - File diff to extract added lines from.
 * @returns Set of 1-indexed line numbers that were added.
 */
export function extractAddedLineNumbers(diff: FileDiff): Set<number> {
  const added = new Set<number>();

  for (const hunk of diff.hunks) {
    const match = /\+(\d+)/.exec(hunk.header);
    if (!match) continue;

    const matchedLine = match[1];
    if (!matchedLine) continue;
    let currentLine = parseInt(matchedLine, 10);
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        continue;
      }

      if (line.startsWith("+")) {
        added.add(currentLine);
        currentLine += 1;
        continue;
      }

      if (line.startsWith("-")) {
        continue;
      }

      currentLine += 1;
    }
  }

  return added;
}

export interface AddedLineInfo {
  readonly content: string;
  readonly hunkHeader: string;
}

/**
 * Extracts a map of added line numbers to their content and hunk header.
 *
 * @param diff - File diff to extract added line info from.
 * @returns Map of 1-indexed line numbers to line content and hunk header.
 */
export function extractAddedLineMap(
  diff: FileDiff,
): Map<number, AddedLineInfo> {
  const added = new Map<number, AddedLineInfo>();

  for (const hunk of diff.hunks) {
    const match = /\+(\d+)/.exec(hunk.header);
    if (!match) continue;

    const matchedLine = match[1];
    if (!matchedLine) continue;
    let currentLine = parseInt(matchedLine, 10);
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        continue;
      }

      if (line.startsWith("+")) {
        added.set(currentLine, {
          content: line.slice(1),
          hunkHeader: hunk.header,
        });
        currentLine += 1;
        continue;
      }

      if (line.startsWith("-")) {
        continue;
      }

      currentLine += 1;
    }
  }

  return added;
}

function isNonCodeLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("/**") ||
    trimmed === "*" ||
    trimmed.startsWith("* ")
  ) {
    return true;
  }
  const stripped = trimmed.replace(/[;,]?\s*$/, "");
  if (
    (stripped.startsWith('"') && stripped.endsWith('"')) ||
    (stripped.startsWith("'") && stripped.endsWith("'")) ||
    (stripped.startsWith("`") && stripped.endsWith("`"))
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts identifier-like tokens from a code string for similarity comparison.
 */
function extractTokens(code: string): Set<string> {
  const matches = code.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
  return new Set(matches ?? []);
}

/**
 * Checks whether a suggestedRewrite is plausibly a replacement for the original line.
 *
 * @remarks
 * Strips rewrites that share no identifiers with the original — a strong signal
 * the LLM hallucinated unrelated code. Also rejects rewrites that are structural
 * suggestions (contain function/class/interface declarations when the original doesn't).
 */
export function isPlausibleRewrite(
  originalLine: string,
  suggestedRewrite: string,
): boolean {
  const trimmedOriginal = originalLine.trim();
  const trimmedRewrite = suggestedRewrite.trim();

  if (trimmedRewrite.length === 0) return false;

  const structuralDeclaration = /^(?:(?:export\s+)?(?:class|interface|enum)\s)/;
  const originalIsStructural = structuralDeclaration.test(trimmedOriginal);
  const rewriteIsStructural = structuralDeclaration.test(trimmedRewrite);
  if (rewriteIsStructural && !originalIsStructural) return false;

  const originalTokens = extractTokens(trimmedOriginal);
  const rewriteTokens = extractTokens(trimmedRewrite);

  if (originalTokens.size === 0 || rewriteTokens.size === 0) return true;

  let shared = 0;
  for (const token of rewriteTokens) {
    if (originalTokens.has(token)) shared += 1;
  }

  const smaller = Math.min(originalTokens.size, rewriteTokens.size);
  if (smaller < 5 && shared < 2) return false;

  const overlapRatio = shared / smaller;
  return overlapRatio >= 0.15;
}

const MAX_REWRITE_LINES = 20;
const DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:(?:function|class|interface|enum|type)\s|const\s+\w+\s*=\s*(?:\(|async\s*\())/;

/**
 * Strips invalid `suggestedRewrite` values from a raw finding.
 *
 * @remarks
 * Returns a copy of the finding without `suggestedRewrite` when the rewrite
 * fails validation: the referenced line is not in the diff, the rewrite
 * exceeds 20 lines, or the rewrite contains function/class declarations
 * not present at the original line. The finding itself is preserved —
 * only the rewrite is removed.
 *
 * @param finding - Raw finding from the LLM.
 * @param addedLines - Set of added line numbers from the diff.
 * @param addedLineMap - Map of added line numbers to their content.
 * @returns The finding, potentially with `suggestedRewrite` removed.
 */
export function sanitiseSuggestedRewrite(
  finding: RawLlmFinding,
  addedLines: Set<number>,
  addedLineMap: Map<number, AddedLineInfo>,
): RawLlmFinding {
  if (typeof finding.suggestedRewrite !== "string" || finding.suggestedRewrite.length === 0) {
    return finding;
  }

  const rewrite = finding.suggestedRewrite;

  if (!addedLines.has(finding.line)) {
    const { suggestedRewrite: _, ...rest } = finding;
    return rest;
  }

  const rewriteLineCount = rewrite.split("\n").length;
  if (rewriteLineCount > MAX_REWRITE_LINES) {
    const { suggestedRewrite: _, ...rest } = finding;
    return rest;
  }

  const lineInfo = addedLineMap.get(finding.line);
  const originalLine = lineInfo?.content ?? "";
  const originalHasDeclaration = DECLARATION_PATTERN.test(originalLine);
  const rewriteLines = rewrite.split("\n");
  const hasHallucinatedDeclaration = !originalHasDeclaration &&
    rewriteLines.some((rewriteLine) => DECLARATION_PATTERN.test(rewriteLine));

  if (hasHallucinatedDeclaration) {
    const { suggestedRewrite: _, ...rest } = finding;
    return rest;
  }

  return finding;
}

function buildLlmPatchPreview(
  suggestedRewrite: string | undefined,
  lineInfo: AddedLineInfo | undefined,
): PatchPreview | undefined {
  if (typeof suggestedRewrite !== "string" || suggestedRewrite.length === 0) return undefined;
  if (!lineInfo) return undefined;
  if (isNonCodeLine(lineInfo.content)) return undefined;
  if (!isPlausibleRewrite(lineInfo.content, suggestedRewrite)) return undefined;

  return {
    removedLines: [lineInfo.content],
    addedLines: suggestedRewrite.split("\n"),
    hunkHeader: lineInfo.hunkHeader,
  };
}

/**
 * Validates and parses raw LLM JSON output into a typed finding array.
 *
 * @remarks
 * Discards findings that reference lines not present in the diff's added
 * lines, have invalid categories, or have out-of-range confidence scores.
 * This prevents hallucinated line numbers from producing ghost comments.
 *
 * @param raw - Raw JSON string from the LLM.
 * @param diff - File diff used to validate line numbers.
 * @param pullRequest - PR metadata for finding attribution.
 * @returns Validated findings ready for the delivery pipeline.
 */
export function parseLlmResponse(
  raw: string,
  diff: FileDiff,
  pullRequest: PullRequestMetadata,
): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isLlmResponse(parsed)) {
    return [];
  }

  const addedLineMap = extractAddedLineMap(diff);
  const addedLines = new Set(addedLineMap.keys());
  const findings: Finding[] = [];

  for (const rawFinding of parsed.findings) {
    if (!isValidRawFinding(rawFinding, addedLines)) {
      continue;
    }

    const firstLineInfo = rawFinding.line === 1 ? addedLineMap.get(1) : undefined;
    if (firstLineInfo && !hasEvidenceLineOverlap(rawFinding.evidence, firstLineInfo.content)) {
      continue;
    }

    const sanitised = sanitiseSuggestedRewrite(rawFinding, addedLines, addedLineMap);
    const lineInfo = addedLineMap.get(sanitised.line);

    const patchPreview = buildLlmPatchPreview(
      sanitised.suggestedRewrite,
      lineInfo,
    );

    const truncatedPrinciple = rawFinding.principle.slice(0, 100);
    const derivedCategory = PRINCIPLE_CATEGORY_MAP.get(rawFinding.principle)
      ?? rawFinding.category as FindingCategory;

    findings.push({
      findingId: `llm/reviewer:${pullRequest.repo}:${pullRequest.prNumber}:${diff.filePath}:${rawFinding.line}:${truncatedPrinciple}`,
      installationId: pullRequest.installationId,
      repo: pullRequest.repo,
      prNumber: pullRequest.prNumber,
      language: "typescript",
      ruleId: toRuleId("llm/reviewer"),
      category: derivedCategory,
      principle: truncatedPrinciple,
      filePath: diff.filePath,
      line: toLineNumber(rawFinding.line),
      evidence: rawFinding.evidence.slice(0, 200),
      recommendation: rawFinding.recommendation.slice(0, 600),
      ...(patchPreview ? { patchPreview } : {}),
      confidence: toConfidence(rawFinding.confidence),
      status: "posted",
    });
  }

  return deduplicateByProximity(findings);
}

/**
 * Checks whether evidence text shares at least one identifier with the
 * content of a code line. Used to detect misanchored findings where the
 * LLM defaults to line 1 but describes code elsewhere in the file.
 *
 * @param evidence - Short code quote from the LLM finding.
 * @param lineContent - Source code at the referenced line.
 * @returns True when at least one identifier token overlaps.
 */
export function hasEvidenceLineOverlap(
  evidence: string,
  lineContent: string,
): boolean {
  const evidenceTokens = extractTokens(evidence);
  const lineTokens = extractTokens(lineContent);

  if (evidenceTokens.size === 0 || lineTokens.size === 0) return true;

  for (const token of evidenceTokens) {
    if (lineTokens.has(token)) return true;
  }
  return false;
}

const PROXIMITY_THRESHOLD = 5;
const MAX_FINDINGS_PER_FILE = 8;

/**
 * Collapses nearby findings of the same category into a single
 * highest-confidence representative, then caps the total count.
 *
 * @param findings - Validated findings to deduplicate.
 * @param proximityThreshold - Maximum line gap within a cluster.
 * @param maxFindings - Hard cap on returned findings.
 * @returns Deduplicated findings sorted by confidence descending.
 */
export function deduplicateByProximity(
  findings: Finding[],
  proximityThreshold: number = PROXIMITY_THRESHOLD,
  maxFindings: number = MAX_FINDINGS_PER_FILE,
): Finding[] {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort(
    (left, right) => left.line - right.line,
  );

  const clusters: Finding[][] = [];
  let currentCluster: Finding[] = [];

  for (const finding of sorted) {
    const previous = currentCluster.at(-1);
    const startsNewCluster =
      !previous || finding.line - previous.line > proximityThreshold;

    if (!startsNewCluster) {
      currentCluster.push(finding);
      continue;
    }

    if (currentCluster.length > 0) clusters.push(currentCluster);
    currentCluster = [finding];
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  const winners: Finding[] = [];

  for (const cluster of clusters) {
    const byPrinciple = new Map<string, Finding[]>();
    for (const finding of cluster) {
      const clusterKey = finding.principle ?? finding.category;
      const existing = byPrinciple.get(clusterKey) ?? [];
      existing.push(finding);
      byPrinciple.set(clusterKey, existing);
    }

    for (const categoryFindings of byPrinciple.values()) {
      const best = categoryFindings.reduce((prev, curr) =>
        curr.confidence > prev.confidence ? curr : prev,
      );
      winners.push(best);
    }
  }

  winners.sort((left, right) => right.confidence - left.confidence);
  return winners.slice(0, maxFindings);
}

function isLlmResponse(value: unknown): value is LlmResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate["findings"]);
}

const COMMENT_LINE_PATTERN = /^\s*(?:\/\/|\/\*|\*\/|\*|\/\*\*)/;

/**
 * Returns true when a line's content is a comment or documentation line.
 */
export function isCommentLine(content: string): boolean {
  return COMMENT_LINE_PATTERN.test(content);
}

function isValidRawFinding(
  finding: unknown,
  addedLines: Set<number>,
): finding is RawLlmFinding {
  if (typeof finding !== "object" || finding === null) return false;
  const candidate = finding as Record<string, unknown>;
  if (typeof candidate["line"] !== "number" || !Number.isInteger(candidate["line"])) {
    return false;
  }
  if (!addedLines.has(candidate["line"])) {
    return false;
  }
  if (typeof candidate["category"] !== "string" || !(VALID_CATEGORIES as ReadonlySet<string>).has(candidate["category"])) {
    return false;
  }
  if (typeof candidate["principle"] !== "string" || candidate["principle"].length === 0) {
    return false;
  }
  if (
    typeof candidate["confidence"] !== "number" ||
    !Number.isFinite(candidate["confidence"]) ||
    candidate["confidence"] < 0 ||
    candidate["confidence"] > 1
  ) {
    return false;
  }
  if (typeof candidate["evidence"] !== "string" || candidate["evidence"].length === 0) {
    return false;
  }
  if (
    typeof candidate["recommendation"] !== "string" ||
    candidate["recommendation"].length === 0
  ) {
    return false;
  }
  return true;
}
