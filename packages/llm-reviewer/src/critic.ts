import type { Finding } from "@mergewise/shared-types";
import { mergeUsage, type CompletionUsage, type ReviewClient } from "./client";
import type { CriticResult, FilteredFinding } from "./pipeline-types";

const MAX_FINDINGS_PER_CRITIC_BATCH = 50;
const MAX_CRITIC_RESPONSE_TOKENS = 2048;
const CRITIC_TEMPERATURE = 0.1;
const MAX_FILE_PATHS_FOR_CONTENT = 30;
const MAX_FIELD_CHARS = 300;
const MAX_CRITIC_PROMPT_CHARS = 30_000;

const CRITIC_SYSTEM_PROMPT = `You are a code review quality filter for a refactoring-focused review tool. You receive findings from a code reviewer and must decide which to keep and which to discard. Your job is to ensure only structural, refactoring-quality feedback survives — the kind a staff engineer would give about maintainability and design.

ALWAYS DISCARD a finding if:
- It suggests adding null checks, optional chaining, defensive validation, or input sanitisation for internal code that is not at an I/O, network, or request-handler boundary
- It suggests adding try-catch to internal code that is not at a system boundary (I/O, network, request handlers)
- It suggests "validate before casting" or "add runtime type checks" for type-safe internal code
- It is about defensive coding or null safety for code that is already type-safe
- It is a style/formatting nit (import ordering, bracket style, naming preferences with no structural impact)
- It is something a linter or TypeScript compiler would catch (unused vars, type errors, formatting)
- It suggests extracting/splitting code that is under 20 lines and already single-purpose
- It says "extract to utility" or "extract to function" without citing 3+ concrete locations of duplicated code
- It suggests a change but does not explain the concrete engineering cost of not changing
- It duplicates another finding — same core suggestion, different words
- It is a secondary optimisation or cleanup that is materially weaker than another finding already covering the main maintainability issue in the same file
- It is generic advice that could apply to any codebase ("consider adding error handling", "this could be more modular", "add validation")
- It does not relate to structural quality, design patterns, or maintainability
- The suggested line range does not match the actual code at those lines
- It attacks a well-structured helper component, local option list, config object, or static data block without concrete behavioural evidence
- It treats a focused React component with stable callbacks or memoised derived data as over-engineered without showing real complexity cost
- It labels a focused React component as mixed-concerns just because it combines rendering, one local UI toggle, and memoised display-only derivations
- It suggests converting a class component to a function component for stylistic consistency rather than a concrete maintenance problem in the diff
- It suggests restructuring static route tables, status maps, or other constant configuration without real behavioural complexity or duplication
- It splits one dependency-inversion issue into multiple comments for each concrete client instead of describing the shared abstraction problem once

NEVER DISCARD a finding about:
- Missing error handling at I/O, network, or request-handler boundaries
- Unbounded output sent to external APIs (GitHub comments, check runs, webhooks)
- Missing size limits on data returned from or sent to external systems

KEEP a finding if:
- It identifies a genuine SRP violation, god function, or mixed-concern problem with a specific cost explanation
- It identifies a missing abstraction (factory, strategy, composition) with concrete evidence of repetition or coupling
- It identifies coupling, prop drilling, or hardcoded dependencies that prevent testing or reuse
- It catches an idiomatic TypeScript/React anti-pattern (derived state via useState+useEffect, stale closures, imperative where declarative fits, unstable context provider values)
- It identifies missing failure handling at a system boundary (I/O, network, external API)
- It suggests a refactoring that would genuinely improve maintainability with a concrete reason tied to this specific code
- It is clearly the single most important maintainability comment in the file, even if smaller secondary issues also exist

When in doubt about a non-boundary finding, DISCARD. Fewer high-quality findings are better than many marginal ones.

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
  const SEPARATOR = "\n\n";
  const PREFIX_RESERVE = 50;
  const formattedFindings: string[] = [];
  let promptLength = PREFIX_RESERVE;
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    if (!finding) continue;
    const formatted = formatFindingForCritic(finding, index, fileContents);
    const separatorCost = formattedFindings.length > 0 ? SEPARATOR.length : 0;
    if (promptLength + separatorCost + formatted.length > MAX_CRITIC_PROMPT_CHARS) break;
    formattedFindings.push(formatted);
    promptLength += separatorCost + formatted.length;
  }

  const summaries = formattedFindings.join(SEPARATOR);
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
