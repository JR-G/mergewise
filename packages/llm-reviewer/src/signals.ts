import type { FileDiff } from "@mergewise/shared-types";

/**
 * Structural signals extracted from a file diff to give the LLM grounding context.
 */
export interface StructuralSignals {
  readonly componentLineCount: number;
  readonly hookCount: number;
  readonly importCount: number;
  readonly maxNestingDepth: number;
}

const HOOK_PATTERN = /\buse(?:State|Effect|Memo|Callback|Ref|Reducer|Context)\s*\(/g;
const IMPORT_PATTERN = /^[+ ]import\s/;
const COMPONENT_PATTERN = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|[^=])*=>)/;
const NESTING_OPENERS = /[({]/g;
const NESTING_CLOSERS = /[)}]/g;

/**
 * Extracts structural signals from a file diff for LLM context.
 *
 * @remarks
 * These signals are cheap to compute from diff content and give
 * the LLM quantitative grounding for responsibility mixing, hook
 * density, and complexity assessments.
 *
 * @param diff - File diff to analyse.
 * @returns Extracted structural signals.
 */
export function extractStructuralSignals(diff: FileDiff): StructuralSignals {
  let hookCount = 0;
  let importCount = 0;
  let maxNestingDepth = 0;
  let currentDepth = 0;
  let componentLineCount = 0;
  let inComponent = false;

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("-")) continue;

      const content = line.slice(1);

      if (IMPORT_PATTERN.test(line)) {
        importCount += 1;
        continue;
      }

      const hookMatches = content.match(HOOK_PATTERN);
      if (hookMatches) {
        hookCount += hookMatches.length;
      }

      if (!inComponent && COMPONENT_PATTERN.test(content)) {
        inComponent = true;
        componentLineCount = 0;
      }

      if (inComponent) {
        componentLineCount += 1;
      }

      const openers = content.match(NESTING_OPENERS);
      const closers = content.match(NESTING_CLOSERS);
      currentDepth += (openers?.length ?? 0) - (closers?.length ?? 0);
      if (currentDepth > maxNestingDepth) {
        maxNestingDepth = currentDepth;
      }
      if (currentDepth < 0) {
        currentDepth = 0;
      }
    }
  }

  return {
    componentLineCount,
    hookCount,
    importCount,
    maxNestingDepth,
  };
}
