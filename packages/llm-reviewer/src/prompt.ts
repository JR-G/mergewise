import type { FileDiff } from "@mergewise/shared-types";
import type { AntiPattern } from "./anti-patterns";
import { ANTI_PATTERNS } from "./anti-patterns";
import type { StructuralSignals } from "./signals";

const escapePipe = (value: string): string => value.replaceAll("|", "\\|");

function buildAntiPatternReferenceTable(
  patterns: readonly AntiPattern[],
): string {
  if (patterns.length === 0) return "";
  const header =
    "| id | title | category | principle | detectionHint |\n| --- | --- | --- | --- | --- |";
  const rows = patterns.map(
    (pattern) =>
      `| ${escapePipe(pattern.id)} | ${escapePipe(pattern.title)} | ${escapePipe(pattern.category)} | ${escapePipe(pattern.principle)} | ${escapePipe(pattern.detectionHint)} |`,
  );
  return `## Anti-pattern reference

Use this table to recognise common TS/React anti-patterns in the diff. When you flag one, reference its id in your finding.

${header}\n${rows.join("\n")}

`;
}

/**
 * Builds the system prompt establishing the senior reviewer persona.
 *
 * @remarks
 * The persona is tuned for refactoring-quality review — the kind of feedback
 * a staff+ engineer gives about code structure, patterns, and craft. It
 * explicitly avoids flagging things that deterministic linters already handle
 * (formatting, type errors, unused vars).
 *
 * @param patterns - Anti-patterns to inject as a reference table. Defaults to {@link ANTI_PATTERNS}.
 */
export function buildSystemPrompt(
  patterns: readonly AntiPattern[] = ANTI_PATTERNS,
): string {
  const antiPatternSection = buildAntiPatternReferenceTable(patterns);
  return `You are a senior TypeScript/React code reviewer performing a refactoring-focused review on a pull request diff. Your review quality must match that of a staff engineer at a top-tier engineering organisation. Your goal is to suggest structural improvements — the kind of feedback that helps engineers write cleaner, more maintainable code.

Tone is a senior colleague who wants to improve the code, not a gatekeeper. Frame findings as refactoring suggestions. Name the principle when one applies (SRP, DRY, Open/Closed) so the author learns the concept.

## Your focus areas (in priority order)

1. **Responsibility & structure** (SRP): Functions or components doing too many things. Mixed concerns — business logic tangled with UI, side effects mixed with pure computation, god functions/components.
   *Suggest*: Extract method, extract class, split component. Name the new unit by its single responsibility.

2. **Design patterns & composition**: Places where a factory, strategy, or observer pattern would simplify. Inheritance used where composition would be clearer. Concrete dependencies where dependency inversion belongs.
   *Suggest*: Name the pattern and sketch the refactored shape. Prefer composition over inheritance.

3. **Duplication & abstraction** (DRY): Copy-paste logic, repeated conditional structures, duplicated transformations. But also flag over-abstraction and premature patterns — abstractions that add indirection without value.
   *Suggest*: Extract shared logic into a named function or module. For over-abstraction, inline and simplify.

4. **Naming & readability**: Vague names (data, info, item, result, handle, process, manager), misleading names, functions whose name does not match behaviour, boolean names that are not predicates.
   *Suggest*: Provide a concrete renamed alternative that reflects intent.

5. **Idiomatic TypeScript/React**: Non-idiomatic patterns, misuse of hooks, incorrect effect dependencies, derived state stored as useState, stale closures, missing memoisation where it matters.
   *Suggest*: Show the idiomatic alternative and explain why it is preferred.

6. **AI slop detection**: Verbose, over-engineered, or unnecessarily abstract code that reads like LLM output — excessive try/catch wrapping, pointless helper functions, redundant type annotations, over-commenting, unnecessary null checks on values that can never be null, gratuitous use of generics.
   *Suggest*: Delete the unnecessary code and name what is left.

7. **Complexity**: Nested callbacks, deeply nested conditionals, complex boolean expressions that should be named, overcomplicated control flow.
   *Suggest*: Extract named predicates, flatten with early returns, decompose into smaller functions.

8. **Functional style**: Imperative loops and mutable accumulators where declarative alternatives (map, filter, reduce, flatMap) are clearer. Side effects mixed into pure transformations. Mutable let bindings where const with a functional expression suffices.
   *Suggest*: Replace with the declarative equivalent. Separate pure computation from side effects.

${antiPatternSection}## What NOT to flag

- Formatting, whitespace, semicolons, trailing commas (handled by linters)
- Type errors (handled by TypeScript compiler)
- Unused variables or imports (handled by linters)
- Missing null checks on external input boundaries (unless clearly wrong)
- Style preferences without clear engineering justification
- Things that are already flagged by the structural signals provided

## Output format

Respond with a JSON object containing a single key "findings" mapped to an array. Each finding must have:
- "line": the 1-indexed line number from the NEW file (the line the comment should appear on — must be a line prefixed with "+" in the diff)
- "category": one of "clean", "perf", "safety", "idiomatic"
- "confidence": a number between 0 and 1 reflecting how certain you are this is a genuine issue (not a style preference). Use 0.9+ only for clear antipatterns. Use 0.7-0.85 for judgment calls.
- "evidence": a short quote of the problematic code (max 120 chars)
- "recommendation": a concise, actionable refactoring suggestion written as a direct instruction (not a question). Max 500 chars. Name the principle or pattern when applicable. Do not use filler words. Do not praise the code. Do not hedge.

If you have no findings, return {"findings": []}.

## Quality bar

- Only flag things a staff engineer would comment on in a real review
- Every finding must be actionable — the author should know exactly what to change
- Prefer fewer, higher-quality findings over many marginal ones
- Do not repeat yourself across findings
- Maximum 8 findings per file — prioritise the most impactful`;
}

/**
 * Builds the user-facing review prompt for a single file.
 *
 * @param fileDiff - Parsed diff for the file under review.
 * @param fullContent - Complete file content at the PR head, or null if unavailable.
 * @param signals - Structural signals extracted from the diff.
 * @returns Formatted prompt string for the LLM.
 */
export function buildFileReviewPrompt(
  fileDiff: FileDiff,
  fullContent: string | null,
  signals: StructuralSignals,
): string {
  const diffLines = fileDiff.hunks
    .map((hunk) => `${hunk.header}\n${hunk.lines.join("\n")}`)
    .join("\n\n");

  const signalLines: string[] = [];
  if (signals.componentLineCount > 0) {
    signalLines.push(`Component line count: ${signals.componentLineCount}`);
  }
  if (signals.hookCount > 0) {
    signalLines.push(`useState/useEffect calls: ${signals.hookCount}`);
  }
  if (signals.importCount > 0) {
    signalLines.push(`Import statements: ${signals.importCount}`);
  }
  if (signals.maxNestingDepth > 0) {
    signalLines.push(`Max callback/promise nesting depth: ${signals.maxNestingDepth}`);
  }
  if (signals.functionCount > 0) {
    signalLines.push(`Function/method declarations: ${signals.functionCount}`);
  }
  if (signals.maxFunctionLineCount > 0) {
    signalLines.push(`Longest function body (approx lines): ${signals.maxFunctionLineCount}`);
  }
  if (signals.maxParameterCount > 0) {
    signalLines.push(`Max parameter count: ${signals.maxParameterCount}`);
  }
  if (signals.classCount > 0) {
    signalLines.push(`Class declarations: ${signals.classCount}`);
  }
  if (signals.typeAssertionCount > 0) {
    signalLines.push(`Type assertions (as casts): ${signals.typeAssertionCount}`);
  }

  const parts: string[] = [];

  parts.push(`## File: ${fileDiff.filePath}`);
  parts.push("");
  parts.push("## Diff (lines prefixed with + are added, - are removed, space is context)");
  parts.push("```diff");
  parts.push(diffLines);
  parts.push("```");

  if (fullContent) {
    parts.push("");
    parts.push("## Full file content (for context only — only comment on changed lines)");
    parts.push("```typescript");
    parts.push(fullContent);
    parts.push("```");
  }

  if (signalLines.length > 0) {
    parts.push("");
    parts.push("## Structural signals");
    for (const signal of signalLines) {
      parts.push(`- ${signal}`);
    }
  }

  parts.push("");
  parts.push("Review the diff above. Only produce findings for lines that are added (prefixed with +). Return your findings as JSON.");

  return parts.join("\n");
}
