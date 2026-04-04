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
  readonly hasMemoizedDisplayDerivation: boolean;
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
const STATIC_CONFIG_ARRAY_PATTERN = /export\s+const\s+\w+:\s+readonly\s+\w+\[\]\s*=\s*\[/;
const STATIC_CONFIG_OBJECT_WITH_CONST_PATTERN = /export\s+const\s+\w+\s*=\s*\{[\s\S]{0,4000}?\}\s*as const\b/;
const STATE_UPDATE_PATTERN = /\bset[A-Z]\w*\s*\(/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const WORD_CHAR_PATTERN = /[A-Za-z0-9_]/;
const FUNCTION_WITH_PARAMS_PATTERN = /^(?:export\s+)?function\s+\w+\(([^)]*)\)/;
const ARROW_FUNCTION_WITH_PARAMS_PATTERN = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/;
const METHOD_WITH_PARAMS_PATTERN = /^(?:(?:public|private|protected|static|async)\s+)*(\w+)\(([^)]*)\)\s*(?::\s*[^{]+)?\{/;
const DESTRUCTURED_FUNCTION_PROPS_PATTERN = /^(?:export\s+)?function\s+\w+\s*\(\{\s*([^}]*)\}\s*:\s*(?:\{[^)]*\}|[A-Za-z_]\w*)/;
const DESTRUCTURED_ARROW_PROPS_PATTERN = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(\{\s*([^}]*)\}\s*:\s*(?:\{[^)]*\}|[A-Za-z_]\w*)\)\s*=>/;
const MAX_REVIEW_SIGNAL_LINES = 2_000;
const MAX_REVIEW_SIGNAL_TEXT_LENGTH = 100_000;
const MAX_TRACKED_IDENTIFIERS = 128;

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
  const diffText = buildBoundedReviewSignalText(diff);
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
      STATIC_CONFIG_OBJECT_WITH_CONST_PATTERN.test(diffText),
    hasParameterMutation: parameterNames.some((parameterName) => hasParameterPropertyMutation(diffText, parameterName)),
    hasMemoizedDisplayDerivation: hasMemoizedDisplayDerivation(diffText),
  };
}

/**
 * Detects a prop name that is forwarded through several component signatures.
 */
function detectRepeatedForwardedProp(diffText: string): string | null {
  const forwardedPropCounts = new Map<string, number>();

  for (const line of diffText.split("\n")) {
    for (const propName of extractDestructuredPropNames(line)) {
      if (!forwardedPropCounts.has(propName) && forwardedPropCounts.size >= MAX_TRACKED_IDENTIFIERS) {
        break;
      }
      forwardedPropCounts.set(propName, (forwardedPropCounts.get(propName) ?? 0) + 1);
    }
  }

  for (const [propName, count] of forwardedPropCounts.entries()) {
    const forwardingUses = countOccurrences(diffText, `${propName}={${propName}}`);
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

  for (const line of diffText.split("\n")) {
    const rawParameterList = extractFunctionParameterList(line);
    if (!rawParameterList) continue;

    for (const rawParameter of rawParameterList.split(",")) {
      const trimmedParameter = rawParameter.trim();
      if (trimmedParameter.length === 0 || trimmedParameter.startsWith("{")) continue;

      const name = trimmedParameter.split(":")[0]?.trim();
      if (!name || !IDENTIFIER_PATTERN.test(name)) continue;
      parameterNames.add(name);
      if (parameterNames.size >= MAX_TRACKED_IDENTIFIERS) {
        return [...parameterNames];
      }
    }
  }

  return [...parameterNames];
}

/**
 * Builds a bounded diff text string for review-signal extraction.
 */
function buildBoundedReviewSignalText(diff: FileDiff): string {
  let diffText = "";
  let includedLineCount = 0;

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("-")) continue;
      const content = line.slice(1);
      if (includedLineCount >= MAX_REVIEW_SIGNAL_LINES) {
        return diffText;
      }

      const separator = diffText.length === 0 ? "" : "\n";
      const nextLength = diffText.length + separator.length + content.length;
      if (nextLength > MAX_REVIEW_SIGNAL_TEXT_LENGTH) {
        return diffText;
      }

      diffText += `${separator}${content}`;
      includedLineCount += 1;
    }
  }

  return diffText;
}

/**
 * Detects memoized display-only derivations in React components.
 */
function hasMemoizedDisplayDerivation(diffText: string): boolean {
  if (!diffText.includes("useMemo(") && !diffText.includes("useMemo (")) {
    return false;
  }

  return [".filter(", ".sort(", ".map("].some((operation) => diffText.includes(operation));
}

/**
 * Extracts a parameter list from common function-like forms.
 */
function extractFunctionParameterList(line: string): string | null {
  const trimmedLine = line.trim();
  const functionMatch = FUNCTION_WITH_PARAMS_PATTERN.exec(trimmedLine);
  if (functionMatch?.[1]) {
    return functionMatch[1];
  }

  const arrowMatch = ARROW_FUNCTION_WITH_PARAMS_PATTERN.exec(trimmedLine);
  if (arrowMatch?.[1]) {
    return arrowMatch[1];
  }

  const methodMatch = METHOD_WITH_PARAMS_PATTERN.exec(trimmedLine);
  const methodName = methodMatch?.[1];
  if (methodName && !["if", "for", "while", "switch", "catch"].includes(methodName) && methodMatch[2]) {
    return methodMatch[2];
  }

  return null;
}

/**
 * Extracts destructured prop names from typed React component signatures.
 */
function extractDestructuredPropNames(line: string): readonly string[] {
  const trimmedLine = line.trim();
  const functionMatch = DESTRUCTURED_FUNCTION_PROPS_PATTERN.exec(trimmedLine);
  const arrowMatch = DESTRUCTURED_ARROW_PROPS_PATTERN.exec(trimmedLine);
  const rawPropList = functionMatch?.[1] ?? arrowMatch?.[1];
  if (!rawPropList) {
    return [];
  }

  const propNames: string[] = [];
  for (const rawProp of rawPropList.split(",")) {
    const trimmedProp = rawProp.trim();
    if (trimmedProp.length === 0) continue;

    const propName = trimmedProp.split(/[:=?]/)[0]?.trim();
    if (!propName || !IDENTIFIER_PATTERN.test(propName)) continue;

    propNames.push(propName);
    if (propNames.length >= MAX_TRACKED_IDENTIFIERS) {
      break;
    }
  }

  return propNames;
}

/**
 * Counts non-overlapping literal occurrences of a substring.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;

  let matchCount = 0;
  let searchIndex = 0;

  while (searchIndex < haystack.length) {
    const matchIndex = haystack.indexOf(needle, searchIndex);
    if (matchIndex === -1) {
      return matchCount;
    }

    matchCount += 1;
    searchIndex = matchIndex + needle.length;
  }

  return matchCount;
}

/**
 * Detects direct property assignment on a function parameter.
 */
function hasParameterPropertyMutation(diffText: string, parameterName: string): boolean {
  const propertyAccessNeedle = `${parameterName}.`;
  let searchIndex = 0;

  while (searchIndex < diffText.length) {
    const matchIndex = diffText.indexOf(propertyAccessNeedle, searchIndex);
    if (matchIndex === -1) {
      return false;
    }

    const precedingCharacter = matchIndex === 0 ? "" : diffText[matchIndex - 1] ?? "";
    if (
      precedingCharacter.length > 0 &&
      (WORD_CHAR_PATTERN.test(precedingCharacter) || precedingCharacter === ".")
    ) {
      searchIndex = matchIndex + propertyAccessNeedle.length;
      continue;
    }

    let cursor = matchIndex + propertyAccessNeedle.length;
    const firstPropertyCharacter = diffText[cursor] ?? "";
    if (!WORD_CHAR_PATTERN.test(firstPropertyCharacter)) {
      searchIndex = cursor;
      continue;
    }

    while (cursor < diffText.length && WORD_CHAR_PATTERN.test(diffText[cursor] ?? "")) {
      cursor += 1;
    }

    while (cursor < diffText.length && /\s/.test(diffText[cursor] ?? "")) {
      cursor += 1;
    }

    if (
      diffText.startsWith("??=", cursor) ||
      diffText.startsWith("||=", cursor) ||
      diffText.startsWith("&&=", cursor) ||
      (diffText[cursor] === "=" && diffText[cursor + 1] !== "=")
    ) {
      return true;
    }

    searchIndex = matchIndex + propertyAccessNeedle.length;
  }

  return false;
}
