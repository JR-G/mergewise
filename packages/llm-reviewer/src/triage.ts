import type { FileDiff } from "@mergewise/shared-types";
import type { CompletionUsage, ReviewClient } from "./client";
import type { TriagePriority, TriageResult } from "./pipeline-types";

const MAX_FILES_PER_TRIAGE_BATCH = 30;
const MAX_TRIAGE_RESPONSE_TOKENS = 2048;
const TRIAGE_TEMPERATURE = 0.1;
const MAX_CLASSIFICATIONS_PER_FILE = 5;
const MAX_HUNK_HEADERS = 3;

const VALID_PRIORITIES = new Set<TriagePriority>(["high", "medium", "low", "skip"]);

const TRIAGE_SYSTEM_PROMPT = `You are classifying code changes for targeted review. For each file, output:
- classifications: what patterns/principles are relevant to review (e.g. "god-function-growth", "new-react-component", "interface-change", "error-handling", "naming-issues", "type-safety", "state-management", "api-boundary")
- priority: how important is this change to review carefully (high, medium, low, skip)
- reasoning: one sentence why

Skip: test files, config changes, pure type definitions, import-only changes.

Consider: function/class size changes, new abstractions, interface modifications, error handling patterns, component structure, coupling between modules.

Respond with JSON: { "files": [{ "filePath": "...", "classifications": [...], "priority": "high|medium|low|skip", "reasoning": "..." }] }`;

interface RawTriageEntry {
  readonly filePath?: unknown;
  readonly classifications?: unknown;
  readonly priority?: unknown;
  readonly reasoning?: unknown;
}

/**
 * Builds a compact one-line summary of a file diff for the triage prompt.
 */
function buildDiffSummary(diff: FileDiff): string {
  const headers = diff.hunks
    .slice(0, MAX_HUNK_HEADERS)
    .map((hunk) => hunk.header)
    .join(", ");

  let addedCount = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) addedCount += 1;
    }
  }

  return `${diff.filePath} (+${addedCount} lines) hunks: ${headers}`;
}

/**
 * Validates and normalises a single raw triage entry from LLM output.
 */
function normaliseTriageEntry(raw: RawTriageEntry, fallbackPath: string): TriageResult {
  const filePath = typeof raw.filePath === "string" ? raw.filePath : fallbackPath;

  const rawClassifications = Array.isArray(raw.classifications)
    ? raw.classifications.filter((item): item is string => typeof item === "string")
    : [];
  const classifications = rawClassifications.slice(0, MAX_CLASSIFICATIONS_PER_FILE);

  const rawPriority = typeof raw.priority === "string" ? raw.priority.toLowerCase() : "medium";
  const priority: TriagePriority = VALID_PRIORITIES.has(rawPriority as TriagePriority)
    ? (rawPriority as TriagePriority)
    : "medium";

  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "Not classified";

  return { filePath, classifications, priority, reasoning };
}

/**
 * Parses the triage LLM response and fills in defaults for missing files.
 */
export function parseTriageResponse(
  raw: string,
  filePaths: readonly string[],
): TriageResult[] {
  let parsed: { files?: unknown[] };
  try {
    parsed = JSON.parse(raw) as { files?: unknown[] };
  } catch {
    return filePaths.map((filePath) => ({
      filePath,
      classifications: [],
      priority: "high" as const,
      reasoning: "Triage response was not valid JSON — defaulting to high priority",
    }));
  }

  const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
  const results = new Map<string, TriageResult>();

  for (let index = 0; index < rawFiles.length && index < filePaths.length; index++) {
    const fallbackPath = filePaths[index] ?? "unknown";
    const normalised = normaliseTriageEntry(rawFiles[index] as RawTriageEntry, fallbackPath);
    results.set(normalised.filePath, normalised);
  }

  return filePaths.map((filePath) =>
    results.get(filePath) ?? {
      filePath,
      classifications: [],
      priority: "medium" as const,
      reasoning: "Not classified by triage",
    },
  );
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
 * Triages a single batch of files.
 */
async function triageBatch(
  diffs: readonly FileDiff[],
  client: ReviewClient,
): Promise<{ results: readonly TriageResult[]; usage: CompletionUsage | undefined }> {
  const summaries = diffs.map((diff) => `- ${buildDiffSummary(diff)}`).join("\n");
  const userPrompt = `Classify these ${diffs.length} changed files:\n\n${summaries}`;
  const filePaths = diffs.map((diff) => diff.filePath);

  const { content, usage } = await client.complete(
    TRIAGE_SYSTEM_PROMPT,
    userPrompt,
    MAX_TRIAGE_RESPONSE_TOKENS,
    TRIAGE_TEMPERATURE,
  );

  return { results: parseTriageResponse(content, filePaths), usage };
}

/**
 * Triages all files in a pull request, batching if more than 30 files.
 *
 * @param diffs - File diffs to classify.
 * @param client - LLM client configured with the triage model.
 * @returns Triage results for every file and aggregated token usage.
 */
export async function triageFiles(
  diffs: readonly FileDiff[],
  client: ReviewClient,
): Promise<{ results: readonly TriageResult[]; usage: CompletionUsage | undefined }> {
  if (diffs.length === 0) {
    return { results: [], usage: undefined };
  }

  if (diffs.length <= MAX_FILES_PER_TRIAGE_BATCH) {
    return triageBatch(diffs, client);
  }

  const allResults: TriageResult[] = [];
  let combinedUsage: CompletionUsage | undefined;

  for (let offset = 0; offset < diffs.length; offset += MAX_FILES_PER_TRIAGE_BATCH) {
    const batch = diffs.slice(offset, offset + MAX_FILES_PER_TRIAGE_BATCH);
    const batchResult = await triageBatch(batch, client);
    allResults.push(...batchResult.results);
    combinedUsage = mergeUsage(combinedUsage, batchResult.usage);
  }

  return { results: allResults, usage: combinedUsage };
}
