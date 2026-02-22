import type {
  FileDiff,
  Finding,
  FindingCategory,
  PullRequestMetadata,
} from "@mergewise/shared-types";

const VALID_CATEGORIES: ReadonlySet<string> = new Set([
  "clean",
  "perf",
  "safety",
  "idiomatic",
]);

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
    const match = hunk.header.match(/\+(\d+)/);
    if (!match) continue;

    let currentLine = parseInt(match[1]!, 10);
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        added.add(currentLine);
        currentLine += 1;
      } else if (line.startsWith("-")) {
        continue;
      } else {
        currentLine += 1;
      }
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

  for (let findingIndex = 0; findingIndex < parsed.findings.length; findingIndex += 1) {
    const rawFinding = parsed.findings[findingIndex];
    if (!rawFinding || !isValidRawFinding(rawFinding, addedLines)) {
      continue;
    }

    findings.push({
      findingId: `llm/reviewer:${pullRequest.repo}:${pullRequest.prNumber}:${diff.filePath}:${rawFinding.line}:${findingIndex}`,
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
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj["findings"]);
}

function isValidRawFinding(
  finding: RawLlmFinding,
  addedLines: Set<number>,
): boolean {
  if (typeof finding.line !== "number" || !Number.isInteger(finding.line)) {
    return false;
  }
  if (!addedLines.has(finding.line)) {
    return false;
  }
  if (!VALID_CATEGORIES.has(finding.category)) {
    return false;
  }
  if (
    typeof finding.confidence !== "number" ||
    finding.confidence < 0 ||
    finding.confidence > 1
  ) {
    return false;
  }
  if (typeof finding.evidence !== "string" || finding.evidence.length === 0) {
    return false;
  }
  if (
    typeof finding.recommendation !== "string" ||
    finding.recommendation.length === 0
  ) {
    return false;
  }
  return true;
}
