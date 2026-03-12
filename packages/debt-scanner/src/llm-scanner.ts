import {
  type ReviewClientConfig,
  createReviewClient,
  buildSystemPrompt,
  type CompletionResult,
} from "@mergewise/llm-reviewer";
import { resolve } from "node:path";
import type { DebtFinding, HotspotEntry } from "./graph-types.ts";

const DEFAULT_MAX_TOKENS_PER_FILE = 2048;
const DEFAULT_TOKEN_BUDGET = 50_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;

interface LlmScannerConfig {
  readonly clientConfig: ReviewClientConfig;
  readonly maxTokensPerFile?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly onFileComplete?: ((filePath: string, findingCount: number) => void) | undefined;
  readonly onFileError?: ((filePath: string, error: unknown) => void) | undefined;
}

interface RawDebtFinding {
  readonly line?: number | undefined;
  readonly endLine?: number | undefined;
  readonly category?: string | undefined;
  readonly confidence?: number | undefined;
  readonly evidence?: string | undefined;
  readonly recommendation?: string | undefined;
  readonly patternId?: string | undefined;
}

/**
 * Sends top hotspot files to the LLM for deep anti-pattern analysis.
 *
 * @param hotspots - Ranked hotspot entries to scan.
 * @param repoPath - Absolute path to the repository root.
 * @param config - LLM client configuration and budget settings.
 * @returns Validated debt findings from the LLM.
 */
export async function scanWithLlm(
  hotspots: readonly HotspotEntry[],
  repoPath: string,
  config: LlmScannerConfig,
): Promise<DebtFinding[]> {
  const client = createReviewClient(config.clientConfig);
  const systemPrompt = buildDebtScanPrompt();
  const maxTokensPerFile = config.maxTokensPerFile ?? DEFAULT_MAX_TOKENS_PER_FILE;
  const tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const onFileComplete = config.onFileComplete;
  const onFileError = config.onFileError;

  const findings: DebtFinding[] = [];
  let estimatedTokensUsed = 0;

  for (const hotspot of hotspots) {
    const absolutePath = resolve(repoPath, hotspot.filePath);
    let content: string;

    try {
      const file = Bun.file(absolutePath);
      content = await file.text();
    } catch {
      onFileError?.(hotspot.filePath, new Error("Failed to read file"));
      continue;
    }

    const estimatedPromptTokens = content.length / ESTIMATED_CHARS_PER_TOKEN;
    if (estimatedTokensUsed + estimatedPromptTokens > tokenBudget) break;

    const userPrompt = buildFilePrompt(hotspot, content);

    let result: CompletionResult;
    try {
      result = await client.complete(systemPrompt, userPrompt, maxTokensPerFile);
    } catch (error) {
      onFileError?.(hotspot.filePath, error);
      continue;
    }

    const fileFindings = parseDebtResponse(result.content, hotspot);
    findings.push(...fileFindings);

    estimatedTokensUsed += result.usage?.totalTokens ?? estimatedPromptTokens;
    onFileComplete?.(hotspot.filePath, fileFindings.length);
  }

  return findings;
}

function buildDebtScanPrompt(): string {
  const basePrompt = buildSystemPrompt();

  return `${basePrompt}

## Debt scan mode

You are scanning a full file (not a diff) for tech debt and anti-patterns. Analyse the ENTIRE file.

Output format: respond with a JSON object containing a "findings" array. Each finding must have:
- "line": 1-indexed line number where the issue starts
- "endLine": 1-indexed line number where the issue ends
- "category": one of "clean", "perf", "safety", "idiomatic"
- "confidence": number between 0.7 and 1.0
- "evidence": short quote of the problematic code (max 120 chars)
- "recommendation": actionable refactoring suggestion (max 500 chars)
- "patternId": the anti-pattern ID from the reference table, or "custom" if not in the table

If the file is well-structured with no significant issues, return {"findings": []}.`;
}

function buildFilePrompt(hotspot: HotspotEntry, content: string): string {
  const parts: string[] = [];

  parts.push(`## File: ${hotspot.filePath}`);
  parts.push(`Line count: ${hotspot.lineCount}`);
  parts.push(`Centrality score: ${hotspot.centrality.toFixed(4)} (${hotspot.centrality > 0.05 ? "high" : "normal"} — many files depend on this)`);
  parts.push(`Signal density: ${hotspot.signalDensity.toFixed(2)}`);
  parts.push("");
  parts.push("```typescript");
  parts.push(content);
  parts.push("```");
  parts.push("");
  parts.push("Analyse this file for anti-patterns and tech debt. Return findings as JSON.");

  return parts.join("\n");
}

function parseDebtResponse(
  raw: string,
  hotspot: HotspotEntry,
): DebtFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];

  const envelope = parsed as Record<string, unknown>;
  if (!Array.isArray(envelope["findings"])) return [];

  const findings: DebtFinding[] = [];

  for (const rawFinding of envelope["findings"] as unknown[]) {
    const validated = validateRawFinding(rawFinding, hotspot);
    if (validated) findings.push(validated);
  }

  return findings;
}

function validateRawFinding(
  raw: unknown,
  hotspot: HotspotEntry,
): DebtFinding | null {
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as RawDebtFinding;

  if (typeof candidate.line !== "number" || !Number.isInteger(candidate.line) || candidate.line < 1) return null;
  if (typeof candidate.confidence !== "number" || candidate.confidence < 0.7 || candidate.confidence > 1) return null;
  if (typeof candidate.category !== "string" || candidate.category.length === 0) return null;
  if (typeof candidate.evidence !== "string" || candidate.evidence.length === 0) return null;
  if (typeof candidate.recommendation !== "string" || candidate.recommendation.length === 0) return null;

  const rawEndLine = typeof candidate.endLine === "number" ? candidate.endLine : candidate.line;
  if (!Number.isInteger(rawEndLine) || rawEndLine < 1 || rawEndLine < candidate.line) return null;
  const endLine = rawEndLine;
  const patternId = typeof candidate.patternId === "string" ? candidate.patternId : "custom";

  return {
    nodeId: hotspot.nodeId,
    patternId,
    category: candidate.category,
    title: candidate.evidence.slice(0, 120),
    recommendation: candidate.recommendation.slice(0, 500),
    confidence: candidate.confidence,
    lineRange: [candidate.line, endLine],
  };
}
