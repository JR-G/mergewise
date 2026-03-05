import type { DiffHunk, FileDiff } from "@mergewise/shared-types";
import type { StructuralSignals } from "./signals";
import type {
  KnowledgeDocument,
  FileGraphContext,
  ReviewLearnings,
} from "./pipeline-types";
import { formatKnowledgeSection } from "./knowledge/format";
import { computeContextWindows } from "./prompt";

const MAX_FULL_FILE_LINES = 2000;
const WINDOWED_COVERAGE_THRESHOLD = 0.9;
const MAX_CALLERS_IN_PROMPT = 10;
const MAX_LEARNINGS_IN_PROMPT = 5;

const SLIM_SYSTEM_PROMPT = `You are a principal-level engineer reviewing a pull request for structural quality. You give the kind of feedback that makes engineers better — not linting, not bug hunting, but the refactoring guidance that comes from years of maintaining large systems.

Your focus: code that will be painful to maintain in 6 months. God functions that accumulate responsibilities. Abstractions at the wrong boundary. Coupling that makes changes cascade. Patterns that fight the language or framework rather than working with them.

Every suggestion must explain the concrete engineering cost of the current code — what breaks, what becomes harder to change, what coupling it creates. "This violates SRP" with no explanation is worthless. Show the developer WHY it matters for THEIR code.

If the code is fine, say nothing. No praise, no filler.

## Output format

Respond with a JSON object containing a single key "findings" mapped to an array. Each finding must have:
- "line": the 1-indexed line number from the NEW file (must be a line prefixed with "+" in the diff)
- "category": one of "clean", "perf", "safety", "idiomatic"
- "confidence": a number between 0.7 and 1.0
- "evidence": a short quote of the problematic code (max 120 chars)
- "recommendation": a concise refactoring suggestion explaining (1) the structural problem, (2) the concrete engineering cost, (3) what to change. Max 600 chars.
- "suggestedRewrite" (optional): drop-in replacement code for the referenced line(s). Only for localised fixes (variable rename, idiomatic API swap, type fix). Omit for structural suggestions like extract-function or split-component.

If you have no findings, return {"findings": []}.

Identify distinct anti-patterns before writing findings. Each finding = one anti-pattern. Maximise breadth across categories.`;

/**
 * Returns the language-agnostic slim system prompt for the pipeline review stage.
 */
export function buildSlimSystemPrompt(): string {
  return SLIM_SYSTEM_PROMPT;
}

/**
 * Builds a numbered file context section using windowed or full file content.
 */
function buildFileContextSection(
  fullContent: string,
  hunks: readonly DiffHunk[],
): string[] {
  const fileLines = fullContent.split("\n");
  const totalLines = fileLines.length;
  const windows = computeContextWindows(hunks, totalLines);

  const cappedLines = fileLines.slice(0, MAX_FULL_FILE_LINES);
  const truncated = fileLines.length > MAX_FULL_FILE_LINES;
  const numberedFull = cappedLines
    .map((line, index) => `// line ${index + 1}: ${line}`)
    .join("\n");

  const fullFileSection = [
    "",
    "## Full file content (for context only — only comment on changed lines)",
    "```",
    numberedFull,
    ...(truncated ? [`// ...[truncated ${fileLines.length - MAX_FULL_FILE_LINES} lines]`] : []),
    "```",
  ];

  if (windows.length === 0) return fullFileSection;

  const windowedLineCount = windows.reduce((sum, window) => sum + (window.end - window.start + 1), 0);
  if (windowedLineCount >= totalLines * WINDOWED_COVERAGE_THRESHOLD || windowedLineCount > MAX_FULL_FILE_LINES) {
    return fullFileSection;
  }

  const parts: string[] = [""];
  for (const window of windows) {
    const slice = fileLines.slice(window.start - 1, window.end);
    const numbered = slice.map((line, index) => `// line ${window.start + index}: ${line}`).join("\n");
    parts.push(`## File context (lines ${window.start}–${window.end} of ${totalLines}) — only comment on changed lines`);
    parts.push("```");
    parts.push(numbered);
    parts.push("```");
  }

  return parts;
}

/**
 * Builds the structural signals section for the prompt.
 */
function buildSignalsSection(signals: StructuralSignals): string[] {
  const lines: string[] = ["", "## Structural signals"];
  if (signals.componentLineCount > 0) lines.push(`- Component line count: ${signals.componentLineCount}`);
  if (signals.hookCount > 0) lines.push(`- Hook calls (useState/useEffect/etc.): ${signals.hookCount}`);
  if (signals.importCount > 0) lines.push(`- Import statements: ${signals.importCount}`);
  if (signals.maxNestingDepth > 0) lines.push(`- Max nesting depth: ${signals.maxNestingDepth}`);
  if (signals.functionCount > 0) lines.push(`- Function/method count: ${signals.functionCount}`);
  if (signals.maxFunctionLineCount > 0) lines.push(`- Longest function (approx lines): ${signals.maxFunctionLineCount}`);
  if (signals.maxParameterCount > 0) lines.push(`- Max parameter count: ${signals.maxParameterCount}`);
  if (signals.classCount > 0) lines.push(`- Class count: ${signals.classCount}`);
  if (signals.typeAssertionCount > 0) lines.push(`- Type assertion count: ${signals.typeAssertionCount}`);

  return lines.length > 2 ? lines : [];
}

/**
 * Configuration for building a dynamic file review prompt.
 */
export interface DynamicPromptInput {
  readonly fileDiff: FileDiff;
  readonly fullContent: string | null;
  readonly signals: StructuralSignals;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly graphContext?: FileGraphContext;
  readonly learnings?: ReviewLearnings;
}

/**
 * Builds the dynamic user prompt for a single file review with retrieved knowledge.
 *
 * @remarks
 * Assembles: diff → file context → structural signals → knowledge →
 * optional graph context → optional learnings. Sections with no data
 * are omitted entirely.
 */
export function buildDynamicFilePrompt(input: DynamicPromptInput): string {
  const parts: string[] = [];

  parts.push(`## File: ${input.fileDiff.filePath}`);
  parts.push("");
  parts.push("## Diff");
  parts.push("```diff");
  const diffContent = input.fileDiff.hunks
    .map((hunk) => `${hunk.header}\n${hunk.lines.join("\n")}`)
    .join("\n\n");
  parts.push(diffContent);
  parts.push("```");

  if (input.fullContent) {
    parts.push(...buildFileContextSection(input.fullContent, input.fileDiff.hunks));
  }

  parts.push(...buildSignalsSection(input.signals));

  const knowledgeSection = formatKnowledgeSection(input.knowledge);
  if (knowledgeSection.length > 0) {
    parts.push("");
    parts.push(knowledgeSection);
  }

  if (input.graphContext) {
    parts.push("", "## Codebase context");
    const callerList = input.graphContext.callers.slice(0, MAX_CALLERS_IN_PROMPT).join(", ");
    parts.push(
      ...(callerList.length > 0 ? [`Callers: ${callerList}`] : []),
      `Centrality: ${input.graphContext.centrality}`,
      ...(input.graphContext.isHotspot ? ["This file is a change hotspot."] : []),
    );
  }

  if (input.learnings && input.learnings.preferences.length > 0) {
    parts.push("");
    parts.push("## Repository preferences");
    for (const preference of input.learnings.preferences.slice(0, MAX_LEARNINGS_IN_PROMPT)) {
      parts.push(`- ${preference}`);
    }
  }

  parts.push("");
  parts.push("Review the diff above. Only produce findings for added lines (prefixed with +). Return findings as JSON.");

  return parts.join("\n");
}
