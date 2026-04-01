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

/**
 * Explicit review-oriented signals extracted from a file diff.
 *
 * @remarks
 * Unlike {@link StructuralSignals}, these booleans capture specific review
 * situations that should influence retrieval, ranking, and suppression.
 */
export interface ReviewSignals {
  readonly hasInlineProviderValue: boolean;
  readonly hasValidationMixedWithStateUpdates: boolean;
  readonly hasRepeatedForwardedProp: boolean;
  readonly forwardedPropName: string | null;
  readonly hasStaticConfigTable: boolean;
  readonly hasParameterMutation: boolean;
}

const HOOK_PATTERN = /\buse(?:State|Effect|Memo|Callback|Ref|Reducer|Context)\s*\(/g;
const IMPORT_PATTERN = /^[+ ]import\s/;
const COMPONENT_PATTERN = /(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|[^=])*=>)/;
const NESTING_OPENERS = /[({]/g;
const NESTING_CLOSERS = /[)}]/g;
const FUNCTION_DECLARATION_PATTERN = /(?:^|\s)(?:function\s+\w+|(?:async\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|(?:public|private|protected|static|async)\s+\w+\s*\(|(?!\b(?:if|for|while|switch|catch)\b)\w+\s*\([^)]*\)\s*(?::\s*\w[^{]*)?{)/;
const CLASS_DECLARATION_PATTERN = /(?:^|\s)class\s+\w+/;
const TYPE_ASSERTION_PATTERN = /\bas\s+\w/g;
const PARAM_LIST_PATTERN = /\(([^)]*)\)/;
const PROVIDER_VALUE_PATTERN = /Provider\s+value=\{\{|\bProvider\s+value=\{[^\n]*\{/;
const FUNCTION_SIGNATURE_PROP_PATTERN = /function\s+\w+\s*\(\{\s*(\w+)\s*\}\s*:\s*\{\s*\1\s*:/g;
const STATIC_CONFIG_ARRAY_PATTERN = /export\s+const\s+\w+:\s+readonly\s+\w+\[\]\s*=\s*\[/;
const STATIC_CONFIG_OBJECT_PATTERN = /export\s+const\s+\w+\s*=\s*\{/;
const STATE_UPDATE_PATTERN = /\b(?:setUser|setToken|setState)\s*\(/;
const FUNCTION_DECLARATION_WITH_PARAMS_PATTERN = /function\s+\w+\(([^)]*)\)/g;

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
  let functionBraceDepthEverPositive = false;
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
        const parameterList = paramMatch?.[1];
        const parameterCount = parameterList
          ? parameterList.split(",").filter((param) => param.trim().length > 0).length
          : 0;
        maxParameterCount = Math.max(maxParameterCount, parameterCount);

        maxFunctionLineCount = inFunction
          ? Math.max(maxFunctionLineCount, currentFunctionLineCount)
          : maxFunctionLineCount;
        inFunction = true;
        currentFunctionLineCount = 0;
        functionBraceDepth = 0;
        functionBraceDepthEverPositive = false;
      }

      if (inFunction) {
        currentFunctionLineCount += 1;
        const openerCount = (content.match(/\{/g) ?? []).length;
        const closerCount = (content.match(/\}/g) ?? []).length;
        functionBraceDepth += openerCount - closerCount;
        functionBraceDepthEverPositive = functionBraceDepthEverPositive || functionBraceDepth > 0;
        const shouldCloseFunction: boolean =
          functionBraceDepth <= 0 &&
          (currentFunctionLineCount > 1 || functionBraceDepthEverPositive);
        maxFunctionLineCount = shouldCloseFunction
          ? Math.max(maxFunctionLineCount, currentFunctionLineCount)
          : maxFunctionLineCount;
        inFunction = shouldCloseFunction ? false : inFunction;
        functionBraceDepthEverPositive = shouldCloseFunction ? false : functionBraceDepthEverPositive;
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

/**
 * Extracts explicit review signals from a file diff.
 *
 * @param diff - File diff to analyse.
 * @returns Review-specific signals for routing and suppression.
 */
export function extractReviewSignals(diff: FileDiff): ReviewSignals {
  const diffText = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => !line.startsWith("-")).join("\n");
  const forwardedPropName = detectRepeatedForwardedProp(diffText);
  const parameterNames = extractFunctionParameterNames(diffText);

  return {
    hasInlineProviderValue: PROVIDER_VALUE_PATTERN.test(diffText),
    hasValidationMixedWithStateUpdates:
      diffText.includes("throw new Error") && STATE_UPDATE_PATTERN.test(diffText),
    hasRepeatedForwardedProp: forwardedPropName !== null,
    forwardedPropName,
    hasStaticConfigTable:
      STATIC_CONFIG_ARRAY_PATTERN.test(diffText) ||
      (STATIC_CONFIG_OBJECT_PATTERN.test(diffText) && diffText.includes("as const")),
    hasParameterMutation: parameterNames.some((parameterName) =>
      new RegExp(`\\b${parameterName}\\.\\w+\\s*(?:=(?!=)|\\?\\?=|\\|\\|=)`).test(diffText)),
  };
}

/**
 * Detects a prop name that is forwarded through several component signatures.
 */
function detectRepeatedForwardedProp(diffText: string): string | null {
  const forwardedPropCounts = new Map<string, number>();

  for (const match of diffText.matchAll(FUNCTION_SIGNATURE_PROP_PATTERN)) {
    const propName = match[1];
    if (!propName) continue;
    forwardedPropCounts.set(propName, (forwardedPropCounts.get(propName) ?? 0) + 1);
  }

  for (const [propName, count] of forwardedPropCounts.entries()) {
    const forwardingUses = diffText.match(new RegExp(`${propName}=\\{${propName}\\}`, "g"))?.length ?? 0;
    if (count >= 3 && forwardingUses >= 2) {
      return propName;
    }
  }

  return null;
}

/**
 * Extracts simple parameter names from function declarations in the diff.
 */
function extractFunctionParameterNames(diffText: string): readonly string[] {
  const parameterNames = new Set<string>();

  for (const match of diffText.matchAll(FUNCTION_DECLARATION_WITH_PARAMS_PATTERN)) {
    const rawParameterList = match[1];
    if (!rawParameterList) continue;

    for (const rawParameter of rawParameterList.split(",")) {
      const trimmedParameter = rawParameter.trim();
      if (trimmedParameter.length === 0 || trimmedParameter.startsWith("{")) continue;

      const name = trimmedParameter.split(":")[0]?.trim();
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
      parameterNames.add(name);
    }
  }

  return [...parameterNames];
}
