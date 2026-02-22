import type { FileDiff } from "@mergewise/shared-types";

/**
 * Structural signals extracted from a file diff to give the LLM grounding context.
 */
export interface StructuralSignals {
  readonly componentLineCount: number;
  readonly hookCount: number;
  readonly importCount: number;
  readonly maxNestingDepth: number;
  readonly functionCount: number;
  readonly maxFunctionLineCount: number;
  readonly maxParameterCount: number;
  readonly classCount: number;
  readonly typeAssertionCount: number;
}

const HOOK_PATTERN = /\buse(?:State|Effect|Memo|Callback|Ref|Reducer|Context)\s*\(/g;
const IMPORT_PATTERN = /^[+ ]import\s/;
const COMPONENT_PATTERN = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|[^=])*=>)/;
const NESTING_OPENERS = /[({]/g;
const NESTING_CLOSERS = /[)}]/g;
const FUNCTION_DECLARATION_PATTERN = /(?:^|\s)(?:function\s+\w+|(?:async\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|(?:public|private|protected|static|async)\s+\w+\s*\(|\w+\s*\([^)]*\)\s*(?::\s*\w[^{]*)?{)/;
const CLASS_DECLARATION_PATTERN = /(?:^|\s)class\s+\w+/;
const TYPE_ASSERTION_PATTERN = /\bas\s+\w/g;
const PARAM_LIST_PATTERN = /\(([^)]*)\)/;

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
  let functionCount = 0;
  let maxFunctionLineCount = 0;
  let currentFunctionLineCount = 0;
  let inFunction = false;
  let functionBraceDepth = 0;
  let maxParameterCount = 0;
  let classCount = 0;
  let typeAssertionCount = 0;

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

      if (CLASS_DECLARATION_PATTERN.test(content)) {
        classCount += 1;
      }

      const typeAssertionMatches = content.match(TYPE_ASSERTION_PATTERN);
      if (typeAssertionMatches) {
        typeAssertionCount += typeAssertionMatches.length;
      }

      if (FUNCTION_DECLARATION_PATTERN.test(content)) {
        functionCount += 1;

        const paramMatch = PARAM_LIST_PATTERN.exec(content);
        if (paramMatch?.[1]) {
          const params = paramMatch[1].split(",").filter((param) => param.trim().length > 0);
          if (params.length > maxParameterCount) {
            maxParameterCount = params.length;
          }
        }

        if (inFunction && currentFunctionLineCount > maxFunctionLineCount) {
          maxFunctionLineCount = currentFunctionLineCount;
        }
        inFunction = true;
        currentFunctionLineCount = 0;
        functionBraceDepth = 0;
      }

      if (inFunction) {
        currentFunctionLineCount += 1;
        const openerCount = (content.match(/\{/g) ?? []).length;
        const closerCount = (content.match(/\}/g) ?? []).length;
        functionBraceDepth += openerCount - closerCount;
        if (functionBraceDepth <= 0 && currentFunctionLineCount > 1) {
          if (currentFunctionLineCount > maxFunctionLineCount) {
            maxFunctionLineCount = currentFunctionLineCount;
          }
          inFunction = false;
        }
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

  if (inFunction && currentFunctionLineCount > maxFunctionLineCount) {
    maxFunctionLineCount = currentFunctionLineCount;
  }

  return {
    componentLineCount,
    hookCount,
    importCount,
    maxNestingDepth,
    functionCount,
    maxFunctionLineCount,
    maxParameterCount,
    classCount,
    typeAssertionCount,
  };
}
