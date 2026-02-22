import type {
  FileDiff,
  Finding,
  FindingCategory,
  PullRequestMetadata,
} from "@mergewise/shared-types";

const VALID_CATEGORIES = new Set<FindingCategory>([
  "clean",
  "perf",
  "safety",
  "idiomatic",
]) satisfies ReadonlySet<FindingCategory>;

/**
 * Raw finding shape expected from the LLM response.
 */
export interface RawLlmFinding {
  readonly line: number;
  readonly category: string;
  readonly confidence: number;
  readonly evidence: string;
  readonly recommendation: string;
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

  const addedLines = extractAddedLineNumbers(diff);
  const findings: Finding[] = [];

  for (const rawFinding of parsed.findings) {
    if (!isValidRawFinding(rawFinding, addedLines)) {
      continue;
    }

    findings.push({
      findingId: `llm/reviewer:${pullRequest.repo}:${pullRequest.prNumber}:${diff.filePath}:${rawFinding.line}:${rawFinding.category}`,
      installationId: pullRequest.installationId,
      repo: pullRequest.repo,
      prNumber: pullRequest.prNumber,
      language: "typescript",
      ruleId: "llm/reviewer",
      category: rawFinding.category as FindingCategory,
      filePath: diff.filePath,
      line: rawFinding.line,
      evidence: rawFinding.evidence.slice(0, 200),
      recommendation: rawFinding.recommendation.slice(0, 500),
      patchSuggestionPolicy: "manual-only",
      confidence: rawFinding.confidence,
      status: "posted",
    });
  }

  return findings;
}

function isLlmResponse(value: unknown): value is LlmResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.findings);
}

function isValidRawFinding(
  finding: unknown,
  addedLines: Set<number>,
): finding is RawLlmFinding {
  if (typeof finding !== "object" || finding === null) return false;
  const candidate = finding as Record<string, unknown>;
  if (typeof candidate.line !== "number" || !Number.isInteger(candidate.line)) {
    return false;
  }
  if (!addedLines.has(candidate.line)) {
    return false;
  }
  if (typeof candidate.category !== "string" || !(VALID_CATEGORIES as ReadonlySet<string>).has(candidate.category)) {
    return false;
  }
  if (
    typeof candidate.confidence !== "number" ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    return false;
  }
  if (typeof candidate.evidence !== "string" || candidate.evidence.length === 0) {
    return false;
  }
  if (
    typeof candidate.recommendation !== "string" ||
    candidate.recommendation.length === 0
  ) {
    return false;
  }
  return true;
}
