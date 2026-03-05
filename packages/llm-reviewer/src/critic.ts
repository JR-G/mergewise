import type { Finding } from "@mergewise/shared-types";
import type { CompletionUsage, ReviewClient } from "./client";
import type { CriticResult, FilteredFinding } from "./pipeline-types";

const MAX_FINDINGS_PER_CRITIC_BATCH = 50;
const MAX_CRITIC_RESPONSE_TOKENS = 2048;
const CRITIC_TEMPERATURE = 0.1;
const MAX_FILE_PATHS_FOR_CONTENT = 30;
const MAX_FIELD_CHARS = 300;
const MAX_CRITIC_PROMPT_CHARS = 30_000;

const CRITIC_SYSTEM_PROMPT = `You are a code review quality filter. You receive findings from a code reviewer and must decide which to keep and which to discard.

DISCARD a finding if:
- It suggests a change but does not explain the concrete engineering cost of not changing
- It is a style/formatting nit (import ordering, bracket style, naming preferences with no structural impact)
- The suggested line range does not match the actual code at those lines
- It duplicates another finding — same core suggestion, different words
- It suggests extracting/splitting code that is under 20 lines
- The "before" code in any suggestion does not match the actual file content at the referenced lines
- It is generic advice that could apply to any codebase without modification ("consider adding error handling", "this could be more modular")

KEEP a finding if:
- It identifies a real structural issue with a clear, specific cost explanation tied to this code
- It suggests a refactoring that would genuinely improve maintainability with a concrete reason
- It catches an error handling gap or type safety issue with real consequences

For each finding, output: keep or discard, plus a one-sentence reason.

Respond with JSON: { "verdicts": [{ "index": 0, "keep": true, "reason": "..." }, ...] }`;

interface RawCriticVerdict {
  readonly index?: unknown;
  readonly keep?: unknown;
  readonly reason?: unknown;
}

/**
 * Parsed and validated verdict from the critic LLM.
 */
export interface CriticVerdict {
  readonly index: number;
  readonly keep: boolean;
  readonly reason: string;
}

/**
 * Truncates a string to a maximum character length with an ellipsis indicator.
 */
function truncateField(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Extracts the source code at a specific line from file contents.
 */
function extractLineContent(
  fileContents: ReadonlyMap<string, string>,
  filePath: string,
  line: number,
): string | undefined {
  const content = fileContents.get(filePath);
  if (!content) return undefined;
  const lines = content.split("\n");
  return lines[line - 1];
}

/**
 * Formats a single finding for the critic prompt.
 */
function formatFindingForCritic(
  finding: Finding,
  index: number,
  fileContents: ReadonlyMap<string, string>,
): string {
  const lineContent = extractLineContent(fileContents, finding.filePath, finding.line);
  const parts = [
    `[${index}] File: ${finding.filePath} Line: ${finding.line}`,
    `  Category: ${finding.category} Confidence: ${finding.confidence}`,
    `  Evidence: ${truncateField(finding.evidence, MAX_FIELD_CHARS)}`,
    `  Recommendation: ${truncateField(finding.recommendation, MAX_FIELD_CHARS)}`,
  ];
  if (lineContent) {
    parts.push(`  Actual code at line: ${truncateField(lineContent, MAX_FIELD_CHARS)}`);
  }
  return parts.join("\n");
}

/**
 * Parses the critic LLM response into validated verdicts.
 */
export function parseCriticResponse(
  raw: string,
  findingCount: number,
): CriticVerdict[] {
  let parsed: { verdicts?: unknown[] };
  try {
    parsed = JSON.parse(raw) as { verdicts?: unknown[] };
  } catch {
    return defaultVerdicts(findingCount);
  }

  const rawVerdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const verdicts: CriticVerdict[] = [];

  for (const entry of rawVerdicts.slice(0, findingCount)) {
    const raw = entry as RawCriticVerdict;
    if (typeof raw.index !== "number" || raw.index < 0 || raw.index >= findingCount) continue;
    verdicts.push({
      index: raw.index,
      keep: typeof raw.keep === "boolean" ? raw.keep : true,
      reason: typeof raw.reason === "string" ? raw.reason : "No reason provided",
    });
  }

  return verdicts;
}

/**
 * Returns default keep verdicts for all findings.
 */
function defaultVerdicts(count: number): CriticVerdict[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    keep: true,
    reason: "Critic response could not be parsed — defaulting to keep",
  }));
}

/**
 * Merges two optional usage values into one.
 */
function mergeUsage(
  left: CompletionUsage | undefined,
  right: CompletionUsage | undefined,
): CompletionUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

/**
 * Splits findings into kept and filtered based on critic verdicts.
 */
export function splitByVerdicts(
  findings: readonly Finding[],
  verdicts: readonly CriticVerdict[],
): CriticResult {
  const verdictMap = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const kept: Finding[] = [];
  const filtered: FilteredFinding[] = [];

  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    if (!finding) continue;
    const verdict = verdictMap.get(index);

    if (!verdict || verdict.keep) {
      kept.push(finding);
      continue;
    }

    filtered.push({ finding, reason: verdict.reason });
  }

  return { findings: kept, filtered };
}

/**
 * Runs the critic on a single batch of findings.
 */
async function criticBatch(
  findings: readonly Finding[],
  batchOffset: number,
  fileContents: ReadonlyMap<string, string>,
  client: ReviewClient,
): Promise<{ verdicts: readonly CriticVerdict[]; usage: CompletionUsage | undefined }> {
  const formattedFindings: string[] = [];
  let promptLength = 0;
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    if (!finding) continue;
    const formatted = formatFindingForCritic(finding, index, fileContents);
    if (promptLength + formatted.length > MAX_CRITIC_PROMPT_CHARS) break;
    formattedFindings.push(formatted);
    promptLength += formatted.length;
  }

  const summaries = formattedFindings.join("\n\n");
  const userPrompt = `Review these ${formattedFindings.length} findings:\n\n${summaries}`;

  const { content, usage } = await client.complete(
    CRITIC_SYSTEM_PROMPT,
    userPrompt,
    MAX_CRITIC_RESPONSE_TOKENS,
    CRITIC_TEMPERATURE,
  );

  const verdicts = parseCriticResponse(content, findings.length).map((verdict) => ({
    ...verdict,
    index: verdict.index + batchOffset,
  }));

  return { verdicts, usage };
}

/**
 * Collects file contents for unique file paths referenced by findings.
 *
 * @param findings - Findings to extract file paths from.
 * @param readFile - Async file reader function.
 * @returns Map of file path to file content.
 */
export async function collectFileContents(
  findings: readonly Finding[],
  readFile: (path: string) => Promise<string | null>,
): Promise<ReadonlyMap<string, string>> {
  const paths = [...new Set(findings.map((finding) => finding.filePath))].slice(0, MAX_FILE_PATHS_FOR_CONTENT);
  const contents = new Map<string, string>();

  for (const filePath of paths) {
    try {
      const content = await readFile(filePath);
      if (content) contents.set(filePath, content);
    } catch {
      continue;
    }
  }

  return contents;
}

/**
 * Filters findings through the critic LLM pass.
 *
 * @remarks
 * Batches findings into groups of 50. The critic does not modify findings —
 * it returns the original findings split into kept and filtered lists.
 *
 * @param findings - Raw findings from the review stage.
 * @param fileContents - File contents for line verification.
 * @param client - LLM client configured with the critic model.
 * @returns Critic result with kept/filtered findings and token usage.
 */
export async function criticFindings(
  findings: readonly Finding[],
  fileContents: ReadonlyMap<string, string>,
  client: ReviewClient,
): Promise<{ result: CriticResult; usage: CompletionUsage | undefined }> {
  if (findings.length === 0) {
    return { result: { findings: [], filtered: [] }, usage: undefined };
  }

  const allVerdicts: CriticVerdict[] = [];
  let combinedUsage: CompletionUsage | undefined;

  for (let offset = 0; offset < findings.length; offset += MAX_FINDINGS_PER_CRITIC_BATCH) {
    const batch = findings.slice(offset, offset + MAX_FINDINGS_PER_CRITIC_BATCH);
    const batchResult = await criticBatch(batch, offset, fileContents, client);
    allVerdicts.push(...batchResult.verdicts);
    combinedUsage = mergeUsage(combinedUsage, batchResult.usage);
  }

  return { result: splitByVerdicts(findings, allVerdicts), usage: combinedUsage };
}
