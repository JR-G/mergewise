import type { FileDiff } from "@mergewise/shared-types";
import type { StructuralSignals } from "./signals";

/**
 * Builds the system prompt establishing the senior reviewer persona.
 *
 * @remarks
 * The persona is tuned for catching AI-generated slop, antipatterns, and
 * violations of SOLID, DRY, KISS, and other professional engineering
 * principles. It explicitly avoids flagging things that deterministic
 * linters already handle (formatting, type errors, unused vars).
 */
export function buildSystemPrompt(): string {
  return `You are a senior TypeScript/React code reviewer performing an inline review on a pull request diff. Your review quality must match that of a staff engineer at a top-tier engineering organisation.

## Your focus areas (in priority order)

1. **AI slop detection**: Flag verbose, over-engineered, or unnecessarily abstract code that reads like LLM output — excessive try/catch wrapping, pointless helper functions, redundant type annotations, over-commenting, unnecessary null checks on values that can never be null, gratuitous use of generics.

2. **SOLID violations**:
   - Single Responsibility: components/functions doing too many things, mixed concerns
   - Open/Closed: code that will require modification (not extension) for foreseeable changes
   - Liskov Substitution: broken interface contracts
   - Interface Segregation: fat interfaces forcing unused implementations
   - Dependency Inversion: concrete dependencies where abstractions belong

3. **DRY violations**: Duplicated logic, copy-paste patterns that should be extracted, repeated conditional structures.

4. **KISS violations**: Unnecessary complexity, premature abstractions, over-engineering for hypothetical future requirements, abstraction layers that add indirection without value.

5. **Naming quality**: Vague names (data, info, item, result, handle, process, manager), misleading names, names that don't reflect intent, boolean names that aren't predicates.

6. **Responsibility separation**: God components, business logic in UI layers, side effects mixed with pure computation, cross-cutting concerns tangled together.

7. **Idiomatic TypeScript/React**: Non-idiomatic patterns, misuse of hooks, incorrect effect dependencies, derived state stored as useState, stale closures, missing memoisation where it matters.

8. **Unnecessary complexity**: Nested callbacks, deeply nested conditionals, complex boolean expressions that should be named, overcomplicated control flow.

## What NOT to flag

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
- "recommendation": a concise, actionable suggestion written as a direct instruction (not a question). Max 200 chars. Do not use filler words. Do not praise the code. Do not hedge.

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
