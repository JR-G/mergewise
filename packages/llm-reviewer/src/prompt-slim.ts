import type { DiffHunk, FileDiff } from "@mergewise/shared-types";
import type { AntiPattern } from "./anti-pattern-types";
import type { ReviewSignals, StructuralSignals } from "./signals";
import type {
  KnowledgeDocument,
  FileGraphContext,
  ReviewLearnings,
} from "./pipeline-types";
import { buildAntiPatternReferenceTable } from "./anti-pattern-table";
import { formatNumberedDiff } from "./diff-format";
import { formatKnowledgeSection } from "./knowledge/format";
import { buildPrContextSection, computeContextWindows } from "./prompt";

const MAX_FULL_FILE_LINES = 2000;
const WINDOWED_COVERAGE_THRESHOLD = 0.9;
const MAX_CALLERS_IN_PROMPT = 10;
const MAX_LEARNINGS_IN_PROMPT = 5;

/** @internal Exported for testing only. */
export const MAX_DIFF_CHARS = 50_000;

const SLIM_SYSTEM_PROMPT = `You are a principal-level engineer reviewing a pull request for structural quality. You give the kind of feedback that makes engineers better — not linting, not bug hunting, not defensive coding advice, but the refactoring guidance that comes from years of maintaining large systems.

You are a refactoring reviewer, not a bug finder or security scanner. Those are separate tools.

## Your focus areas (in priority order)

1. **SRP violations and god functions/components**: Functions or components doing too many things. Mixed concerns — business logic tangled with UI, side effects mixed with pure computation, fetching tangled with rendering.
   Suggest: Extract method, extract hook, split component. Name the extracted unit by the concern it handles.

2. **Missing abstractions and design patterns**: Places where a factory, strategy, or observer pattern would simplify. Repeated conditional structures (switch/if-else chains that will grow with every new variant). Concrete dependencies where dependency inversion belongs.
   Suggest: Name the pattern and sketch the refactored shape.

3. **Coupling problems**: Hardcoded dependencies that prevent testing. Prop drilling through layers that don't use the data. Tight coupling between modules that should be independent. Mutation leaking across call boundaries.
   Suggest: Accept dependencies as parameters, use context or composition, clone before mutating.

4. **Idiomatic TypeScript/React**: Derived state stored in useState+useEffect instead of computed directly. Stale closures. useEffect as event handler. Imperative transforms where declarative (map/filter) would be clearer. Inconsistent absence representation (mixing null, undefined, optional).
   Suggest: Show the idiomatic alternative and explain why it is preferred.
   React-specific patterns (hooks, JSX, components, memoisation) only apply to .tsx/.jsx files.
   When a diff contains prop drilling and a smaller React style issue, prioritise the prop drilling. Architecture beats stylistic consistency.

5. **Duplication (DRY)**: Copy-paste logic across 3+ locations, repeated conditional structures, duplicated transformations. Only flag when there is concrete evidence of duplication in the diff or file context.
   Suggest: Extract shared logic into a named function. Reference the duplicated locations.

6. **AI slop detection**: Over-engineered code that reads like LLM output — excessive try/catch wrapping, pointless helper functions, redundant type annotations, unnecessary null checks on values that can never be null.
   Suggest: Delete the unnecessary code.

Every suggestion must explain the concrete engineering cost of the current code — what breaks, what becomes harder to change, what coupling it creates. "This violates SRP" with no explanation is worthless. Show the developer WHY it matters for THEIR code.

If the code is fine, say nothing. No praise, no filler. Returning {"findings": []} is correct and expected for well-written code.

Default to the smallest useful review. Most files should produce 0 or 1 findings. Add a second finding only when it is independently high-value and not just a weaker side effect of the main issue.

Prioritise the strongest maintainability problem over secondary cleanups. One sharp comment about the real design issue is better than three medium-value comments.

## Anti-instructions — do NOT do any of these

- Do NOT suggest adding null checks, optional chaining, or defensive validation for internal code that is already type-safe. The type system handles this.
- Do NOT flag type assertions inside type guard functions or narrow-scope validated contexts.
- Do NOT comment on formatting, naming conventions, semicolons, or import ordering — those are handled by linters.
- Do NOT suggest "extract to function" or "extract to utility" without citing concrete duplication (3+ identical blocks in the diff or file). A single block of logic does not need extraction.
- Do NOT suggest error handling additions unless the code is at a system boundary (API handler, file I/O, network call). Internal function calls between trusted modules do not need try/catch.
- Do NOT act as a linter, bug finder, or security scanner — those are separate tools. Never suggest adding validation, input sanitisation, or defensive checks.
- Do NOT flag type errors that the TypeScript compiler would catch.
- Do NOT suggest splitting functions that are under ~20 lines and single-purpose. Short, focused functions are already well-structured.
- Do NOT suggest splitting orchestrator or pipeline functions that call a sequence of extracted helpers. Orchestration IS the single responsibility.
- Do NOT suggest moving module-level constants into function scope.
- Do NOT flag configuration objects, static data arrays, or constant maps unless they contain actual behavioural logic.
- Do NOT flag test utility code, factories, or fixture builders for production architecture patterns.
- Do NOT manufacture extra findings on already-clean React code. Focused components, small helper components, and direct parent-to-child prop passing are usually not design smells by themselves.
- Do NOT suggest converting a class component to a function component unless the class form is causing a concrete maintenance problem in this diff. Style consistency alone is not enough.
- Do NOT suggest restructuring static configuration unless the diff introduces real behavioural complexity or change-amplifying duplication.
- Do NOT turn one structural issue into multiple weaker comments. Prefer one strong comment about the main abstraction problem.
- Do NOT produce generic advice that could apply to any codebase ("consider adding error handling", "this could be more modular", "validate before casting").

## Output format

Respond with a JSON object containing a single key "findings" mapped to an array. Each finding must have:
- "line": the 1-indexed line number from the NEW file (must be a line prefixed with "+" in the diff)
- "category": one of "clean", "perf", "safety", "idiomatic". Your category MUST match the principle you cited — use the anti-pattern reference table's category column when citing a catalogued principle. Mapping for standard principles: SRP/OCP/LSP/ISP/DIP/KISS/YAGNI/DRY → "clean", derive-dont-sync/hooks-rules/effects-for-sync → "idiomatic", memoise/stable-references → "perf", type-safety/defensive-typing → "safety".
- "principle": the named anti-pattern or design principle this finding addresses (e.g. "SRP", "DIP", "derive-dont-sync"). Must be a specific, named principle — use the principle column from the anti-pattern reference table when one matches, otherwise use a standard principle name (SRP, OCP, LSP, ISP, DIP, DRY, KISS, YAGNI). Never use generic labels like "best-practice", "code-quality", or "clean-code".
- "confidence": a number between 0.7 and 1.0
- "evidence": a short quote of the problematic code (max 120 chars)
- "recommendation": a concise refactoring suggestion explaining (1) the structural problem, (2) the concrete engineering cost, (3) what to change. Max 600 chars.
- "suggestedRewrite" (optional): drop-in replacement code for the referenced line(s). Only for localised fixes (variable rename, idiomatic API swap, type fix). Omit for structural suggestions like extract-function or split-component.

If you have no findings, return {"findings": []}.

Identify distinct anti-patterns before writing findings. Each finding = one anti-pattern, one principle. Report one finding per root cause, not one per symptom. Maximise breadth across categories.`;

const AGENT_FRIENDLINESS_ADDENDUM = `

## Additional focus: AI agent compatibility

When reviewing, also look for patterns that make this code difficult for AI coding agents to work with autonomously. These are structural issues that impair an agent's ability to understand, navigate, and safely modify the codebase.

7. **Context window overflows**: Files or functions large enough that an AI agent cannot fit them in a single context window alongside the necessary surrounding code. A 300-line function with 8 dependencies means the agent must load ~500+ lines of context before it can reason about a change.
   Suggest: Break into focused modules that an agent can load and modify independently.

8. **Implicit conventions and hidden coupling**: Magic strings, undocumented side effects, ordering dependencies, or conventions only discoverable by reading distant code. An agent following the type signatures will produce correct-looking but broken code.
   Suggest: Make conventions explicit through types, named constants, or enforced interfaces.

9. **Tangled read/write operations**: Functions that mix reading state, computing, and writing side effects. An agent cannot safely make a targeted edit because the read and write concerns are interleaved — changing one line risks breaking the other.
   Suggest: Separate pure computation from side effects so an agent can modify either independently.

10. **Missing interfaces and entry points**: Modules with no clear public API surface — everything is exported, or the entry point depends on implicit knowledge of which function to call first. An agent cannot determine where to integrate without understanding the full module.
    Suggest: Define explicit interfaces or barrel exports that make the module's contract obvious.

11. **Distributed state mutations**: State changes spread across multiple files with no central coordination point. An agent modifying one mutation site has no way to discover the others without searching the entire codebase.
    Suggest: Centralise related mutations behind a single coordination module.

For every suggestion (including standard refactoring findings), explain the AI agent impact alongside the engineering cost. If codebase context is provided (callers, centrality, hotspot status), cite those metrics as evidence of the impact radius.`;

const TOOL_USE_ADDENDUM = `

## Available tools

You have tools to retrieve additional context about the file under review. Use them when the diff alone is insufficient to make a confident judgement. Do not call tools speculatively — only when you need specific information.

- read_file_section: Read a range of lines from the current file to understand surrounding context
- get_callers: See which files depend on this file and its centrality/hotspot status
- lookup_pattern: Retrieve detailed guidance for a specific anti-pattern by ID
- get_repo_preferences: Get repository-specific review preferences from prior feedback

Most files need 0–2 tool calls. Simple diffs need none.`;

/**
 * Options for building the slim system prompt.
 */
export interface SlimSystemPromptOptions {
  readonly agentFriendliness?: boolean | undefined;
  readonly toolUse?: boolean | undefined;
}

/**
 * Returns the language-agnostic slim system prompt for the pipeline review stage.
 */
export function buildSlimSystemPrompt(options?: SlimSystemPromptOptions): string {
  let prompt = SLIM_SYSTEM_PROMPT;
  if (options?.agentFriendliness) {
    prompt += AGENT_FRIENDLINESS_ADDENDUM;
  }
  if (options?.toolUse) {
    prompt += TOOL_USE_ADDENDUM;
  }
  return prompt;
}

/**
 * Formats diff hunks into a fenced diff section, truncating at MAX_DIFF_CHARS.
 */
function formatDiffSection(hunks: readonly DiffHunk[]): string[] {
  let diffContent = formatNumberedDiff(hunks);
  if (diffContent.length > MAX_DIFF_CHARS) {
    diffContent = `${diffContent.slice(0, MAX_DIFF_CHARS)}\n...(truncated)`;
  }
  return ["", "## Diff", "```diff", diffContent, "```"];
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

function buildReviewSignalsSection(reviewSignals: ReviewSignals): string[] {
  const lines: string[] = [];

  if (reviewSignals.hasInlineProviderValue) {
    lines.push(
      "- Inline Context.Provider value detected. Check whether a new object or callback reference is recreated on every render and whether useMemo/useCallback would prevent avoidable consumer re-renders.",
    );
  }

  if (reviewSignals.hasValidationMixedWithStateUpdates) {
    lines.push(
      "- Validation logic and state updates appear interleaved in the same React flow. Check whether validation/token creation can be extracted into a pure helper so the provider only coordinates state updates.",
    );
  }

  if (reviewSignals.hasRepeatedForwardedProp) {
    const propName = reviewSignals.forwardedPropName ?? "the same prop";
    lines.push(
      `- Repeated forwarding of \`${propName}\` detected across multiple component signatures. Check for prop drilling through intermediaries that do not use the value directly.`,
    );
  }

  if (reviewSignals.hasStaticConfigTable) {
    lines.push(
      "- Static configuration table detected. Stay quiet unless the diff introduces real branching behaviour, duplicated update paths, or other change-amplifying logic.",
    );
  }

  if (reviewSignals.hasParameterMutation) {
    lines.push(
      "- Function parameter mutation detected. Check whether the helper is mutating an input object that callers may still reference, and prefer returning a new object instead.",
    );
  }

  return lines.length > 0 ? ["", "## Review signals", ...lines] : [];
}

/**
 * Configuration for building a dynamic file review prompt.
 */
export interface DynamicPromptInput {
  readonly fileDiff: FileDiff;
  readonly fullContent: string | null;
  readonly signals: StructuralSignals;
  readonly reviewSignals?: ReviewSignals | undefined;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly filteredPatterns?: readonly AntiPattern[] | undefined;
  readonly graphContext?: FileGraphContext | undefined;
  readonly learnings?: ReviewLearnings | undefined;
  readonly prTitle?: string | undefined;
  readonly prDescription?: string | undefined;
  readonly agentFriendliness?: boolean | undefined;
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
  parts.push(...buildPrContextSection(input.prTitle, input.prDescription));

  parts.push(...formatDiffSection(input.fileDiff.hunks));

  if (input.fullContent) {
    parts.push(...buildFileContextSection(input.fullContent, input.fileDiff.hunks));
  }

  parts.push(...buildSignalsSection(input.signals));
  if (input.reviewSignals) {
    parts.push(...buildReviewSignalsSection(input.reviewSignals));
  }

  const knowledgeSection = formatKnowledgeSection(input.knowledge);
  if (knowledgeSection.length > 0) {
    parts.push("");
    parts.push(knowledgeSection);
  }

  const patternTable = input.filteredPatterns
    ? buildAntiPatternReferenceTable(input.filteredPatterns)
    : "";
  if (patternTable.length > 0) {
    parts.push("");
    parts.push(patternTable);
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

  if (input.agentFriendliness && input.graphContext) {
    parts.push(
      "",
      "Use the caller count, centrality score, and hotspot status above as evidence when explaining AI agent impact in your suggestions.",
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

/**
 * Configuration for building a tool-use file review prompt.
 *
 * @remarks
 * Unlike {@link DynamicPromptInput}, this excludes all context that is
 * now available via tool calls (file content, knowledge, graph, learnings).
 */
export interface ToolUsePromptInput {
  readonly fileDiff: FileDiff;
  readonly signals: StructuralSignals;
  readonly reviewSignals?: ReviewSignals | undefined;
  readonly prTitle?: string | undefined;
  readonly prDescription?: string | undefined;
  readonly availablePatterns: string;
}

/**
 * Builds a lean user prompt for tool-use review.
 *
 * @remarks
 * Includes only the diff, structural signals, and available patterns summary.
 * Full file content, knowledge docs, graph context, and learnings are
 * available via tool calls — not stuffed into the prompt.
 */
export function buildToolUseFilePrompt(input: ToolUsePromptInput): string {
  const parts: string[] = [];

  parts.push(`## File: ${input.fileDiff.filePath}`);
  parts.push(...buildPrContextSection(input.prTitle, input.prDescription));

  parts.push(...formatDiffSection(input.fileDiff.hunks));

  parts.push(...buildSignalsSection(input.signals));
  if (input.reviewSignals) {
    parts.push(...buildReviewSignalsSection(input.reviewSignals));
  }

  parts.push("");
  parts.push(input.availablePatterns);

  parts.push("");
  parts.push("Review the diff above. Use tools if you need more context about the file, its callers, or relevant anti-patterns. Only produce findings for added lines (prefixed with +). Return findings as JSON.");

  return parts.join("\n");
}
