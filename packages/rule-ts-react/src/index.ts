import type { AnalysisContext, Finding, PatchPreview, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";

import {
  TYPE_SCRIPT_FILE_PATTERN,
  TYPE_SCRIPT_JSX_FILE_PATTERN,
  findAddedNodesWhere,
  isOnAddedLine,
  parseChangedFiles,
  parseHunkStartingLine,
} from "./ast";

const NON_CODE_MARKER_PATTERN = /(?:'|"|`|\/\/|\/\*)/;

const UNSAFE_ANY_RULE_IDENTIFIER = "ts-react/no-unsafe-any";
const NON_NULL_ASSERTION_RULE_IDENTIFIER = "ts-react/no-non-null-assertion";
const ARRAY_INDEX_KEY_RULE_IDENTIFIER = "ts-react/no-array-index-key";
const DEBUGGER_STATEMENT_RULE_IDENTIFIER = "ts-react/no-debugger-statement";
const TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER = "ts-react/no-type-assertion-chain";
const ENUM_DECLARATION_RULE_IDENTIFIER = "ts-react/no-enum";
const NESTED_TERNARY_RULE_IDENTIFIER = "ts-react/no-nested-ternary";
const NEGATED_CONDITION_RULE_IDENTIFIER = "ts-react/no-negated-condition";
const EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER = "ts-react/no-excessive-optional-chaining";

const UNSAFE_ANY_PATTERN = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|\bReadonlyArray\s*<\s*any\s*>|\bPromise\s*<\s*any\s*>)/;
const ONLY_DEBUGGER_STATEMENT_PATTERN = /^\s*debugger\s*;?\s*$/;
const INDEX_VARIABLE_NAMES = new Set(["index", "idx", "i"]);

interface LineScanState {
  insideBlockComment: boolean;
}

interface AddedLine {
  filePath: string;
  lineNumber: number;
  evidence: string;
  sanitizedContent: string;
  hunkHeader: string;
}

/**
 * Stateless rule that flags explicit `any` usage in changed TypeScript and React files.
 */
export const unsafeAnyUsageRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: UNSAFE_ANY_RULE_IDENTIFIER,
    name: "Unsafe any usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects explicit any usage in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_FILE_PATTERN)) {
      if (!UNSAFE_ANY_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      const suggestedReplacement = buildManualReplacementCandidate(
        addedLine.evidence,
        addedLine.sanitizedContent,
      );
      const patchPreview =
        suggestedReplacement === null
          ? undefined
          : buildPatchPreview(addedLine.hunkHeader, addedLine.evidence, suggestedReplacement);

      findings.push(
        buildFinding(context, {
          ruleId: UNSAFE_ANY_RULE_IDENTIFIER,
          category: "safety",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation: buildUnsafeAnyRecommendation(suggestedReplacement),
          patchPreview,
          confidence: 0.95,
        }),
      );
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags non-null assertions (`!`) in changed TypeScript and React files.
 *
 * @remarks
 * Uses the TypeScript AST to identify `NonNullExpression` nodes and strips them
 * from the evidence to produce a patch preview. Definite-assignment assertions
 * on class fields are excluded.
 */
export const nonNullAssertionRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NON_NULL_ASSERTION_RULE_IDENTIFIER,
    name: "Non-null assertion usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects non-null assertions in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const visit = (node: ts.Node): void => {
        if (ts.isNonNullExpression(node)) {
          const lineInfo = isOnAddedLine(parsedFile, node);
          if (lineInfo && !seen.has(lineInfo.lineNumber)) {
            if (isDefiniteAssignmentContext(node)) {
              ts.forEachChild(node, visit);
              return;
            }
            seen.add(lineInfo.lineNumber);
            const scriptKind = TYPE_SCRIPT_JSX_FILE_PATTERN.test(parsedFile.filePath)
              ? ts.ScriptKind.TSX
              : ts.ScriptKind.TS;
            const replacementLine = buildNonNullAssertionReplacement(
              lineInfo.evidence,
              scriptKind,
            );
            const patchPreview = replacementLine
              ? buildPatchPreview(lineInfo.hunkHeader, lineInfo.evidence, replacementLine)
              : undefined;

            findings.push(
              buildFinding(context, {
                ruleId: NON_NULL_ASSERTION_RULE_IDENTIFIER,
                category: "safety",
                filePath: parsedFile.filePath,
                line: lineInfo.lineNumber,
                evidence: lineInfo.evidence,
                recommendation:
                  "Avoid non-null assertions. Add an explicit null guard or narrow the value before access so runtime null cases stay safe.",
                patchPreview,
                confidence: 0.92,
              }),
            );
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(parsedFile.sourceFile);
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags JSX `key` props backed by array indexes.
 *
 * @remarks
 * Uses AST to find JSX attributes named `key` whose initialiser is an identifier
 * commonly used as a map callback index parameter (`index`, `idx`, `i`).
 */
export const arrayIndexKeyRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: ARRAY_INDEX_KEY_RULE_IDENTIFIER,
    name: "Array index React key",
    category: "idiomatic",
    languages: ["tsx"],
    description: "Detects JSX key props that use array index variables.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context, TYPE_SCRIPT_JSX_FILE_PATTERN)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isJsxAttribute(node)) return false;
        if (!ts.isIdentifier(node.name) || node.name.text !== "key") return false;
        if (!node.initializer || !ts.isJsxExpression(node.initializer)) return false;
        const expression = node.initializer.expression;
        if (!expression || !ts.isIdentifier(expression)) return false;
        return INDEX_VARIABLE_NAMES.has(expression.text);
      });

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: ARRAY_INDEX_KEY_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Do not use array index as a React key. Use a stable identifier from the item data so reorder and insertion operations keep component state aligned.",
            confidence: 0.9,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags debugger statements in changed TypeScript and React files.
 *
 * @remarks
 * Uses AST to find `DebuggerStatement` nodes on added lines.
 */
export const debuggerStatementRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: DEBUGGER_STATEMENT_RULE_IDENTIFIER,
    name: "Debugger statement",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects debugger statements in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) =>
        ts.isDebuggerStatement(node),
      );

      for (const match of astFindings) {
        const patchPreview = ONLY_DEBUGGER_STATEMENT_PATTERN.test(match.evidence)
          ? { hunkHeader: match.hunkHeader, removedLines: [match.evidence], addedLines: [] as string[] }
          : undefined;

        findings.push(
          buildFinding(context, {
            ruleId: DEBUGGER_STATEMENT_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Remove debugger statements before merge. Keep temporary debugging local and use logging or tests for persistent diagnostics.",
            patchPreview,
            confidence: 0.97,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags `as unknown as T` type assertion chains.
 *
 * @remarks
 * Double type assertions bypass the type system entirely. This pattern is a
 * stronger red flag than a single `as` cast because it signals intentional
 * circumvention of type safety rather than a simple widening.
 */
export const typeAssertionChainRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER,
    name: "Type assertion chain",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects double type assertions (as unknown as T) that bypass the type system.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isAsExpression(node)) return false;
        return ts.isAsExpression(node.expression);
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        findings.push(
          buildFinding(context, {
            ruleId: TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER,
            category: "safety",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Double type assertions (`as X as Y`) bypass the type system entirely. Introduce a proper type guard, generic constraint, or redesign the types so the compiler can verify the conversion without a forced cast chain.",
            confidence: 0.95,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags `enum` declarations in favour of `as const` objects.
 *
 * @remarks
 * TypeScript enums produce runtime code, have surprising structural typing
 * behaviour, and cannot be tree-shaken. The modern idiomatic alternative
 * is a plain object with `as const` and a derived union type.
 */
export const enumDeclarationRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: ENUM_DECLARATION_RULE_IDENTIFIER,
    name: "Enum declaration",
    category: "idiomatic",
    languages: ["typescript", "tsx"],
    description: "Detects enum declarations where as-const objects are preferred.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) =>
        ts.isEnumDeclaration(node),
      );

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: ENUM_DECLARATION_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Prefer `as const` objects over enums. Enums produce runtime code, have surprising nominal typing behaviour, and prevent tree-shaking. Use `const Status = { Active: 'active', Inactive: 'inactive' } as const` with `type Status = typeof Status[keyof typeof Status]` instead.",
            confidence: 0.88,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags nested ternary expressions.
 *
 * @remarks
 * Nested ternaries reduce readability significantly. This is especially
 * problematic in JSX where they create deeply nested conditional rendering.
 */
export const nestedTernaryRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NESTED_TERNARY_RULE_IDENTIFIER,
    name: "Nested ternary expression",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects nested ternary expressions that reduce readability.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isConditionalExpression(node)) return false;
        return containsNestedConditional(node.whenTrue) ||
          containsNestedConditional(node.whenFalse);
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        const isJsx = isInsideJsxExpression(match.node);

        findings.push(
          buildFinding(context, {
            ruleId: NESTED_TERNARY_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation: isJsx
              ? "Nested ternaries in JSX create unreadable conditional rendering. Extract conditions into early returns, a lookup object, or a dedicated component that handles each branch."
              : "Nested ternary expressions are difficult to read and maintain. Use if/else statements, early returns, or a mapping object instead.",
            confidence: 0.9,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags `if (!condition)` with an else branch.
 *
 * @remarks
 * Negated conditions with else branches force readers to perform double
 * negation mentally. Flipping the branches improves readability.
 */
export const negatedConditionRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NEGATED_CONDITION_RULE_IDENTIFIER,
    name: "Negated condition with else",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects negated if-conditions that have else branches, suggesting the positive path first.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isIfStatement(node)) return false;
        if (!node.elseStatement) return false;
        if (ts.isIfStatement(node.elseStatement)) return false;
        return isNegatedExpression(node.expression);
      });

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: NEGATED_CONDITION_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Avoid negated conditions when an else branch exists. Flip the condition to test the positive case first so readers avoid mental double-negation.",
            confidence: 0.85,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Stateless rule that flags deeply chained optional access (`?.`).
 *
 * @remarks
 * Chains of three or more optional accesses signal that the data model
 * is poorly typed or that the code is defensively programming around
 * nullable values instead of narrowing them up front.
 */
export const excessiveOptionalChainingRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER,
    name: "Excessive optional chaining",
    category: "idiomatic",
    languages: ["typescript", "tsx"],
    description: "Detects deeply chained optional access (3+ levels) suggesting poor nullability modelling.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!node.parent) return false; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- parent may be undefined at AST root
        if (isOptionalChainNode(node.parent)) return false;
        return countOptionalChainDepth(node) >= 3;
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        findings.push(
          buildFinding(context, {
            ruleId: EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Deeply chained optional access (`?.?.?.`) suggests the types allow too many nullable intermediate values. Narrow nullability earlier with a guard or redesign the data model so intermediate objects are non-optional.",
            confidence: 0.82,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

/**
 * Deterministic list of stateless TypeScript and React rules for worker consumption.
 */
export const tsReactRules: readonly StatelessRule[] = [
  unsafeAnyUsageRule,
  nonNullAssertionRule,
  arrayIndexKeyRule,
  debuggerStatementRule,
  typeAssertionChainRule,
  enumDeclarationRule,
  nestedTernaryRule,
  negatedConditionRule,
  excessiveOptionalChainingRule,
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildFinding(
  context: AnalysisContext,
  findingCore: {
    ruleId: string;
    category: Finding["category"];
    filePath: string;
    line: number;
    evidence: string;
    recommendation: string;
    patchPreview?: PatchPreview;
    confidence: number;
  },
): Finding {
  const findingIdentifier = `${findingCore.ruleId}:${context.pullRequest.repo}:${context.pullRequest.prNumber}:${findingCore.filePath}:${findingCore.line}`;

  return {
    findingId: findingIdentifier,
    installationId: context.pullRequest.installationId,
    repo: context.pullRequest.repo,
    prNumber: context.pullRequest.prNumber,
    language: "typescript",
    ruleId: findingCore.ruleId,
    category: findingCore.category,
    filePath: findingCore.filePath,
    line: findingCore.line,
    evidence: findingCore.evidence,
    recommendation: findingCore.recommendation,
    patchPreview: findingCore.patchPreview,
    confidence: findingCore.confidence,
    status: "posted",
  };
}

function buildPatchPreview(
  hunkHeader: string,
  removedLine: string,
  addedLine: string,
): PatchPreview {
  return {
    hunkHeader,
    removedLines: [removedLine],
    addedLines: [addedLine],
  };
}

// ---------------------------------------------------------------------------
// unsafe-any helpers (kept regex-based – AST `any` keyword detection
// requires type-checker program which is unavailable in diff-only context)
// ---------------------------------------------------------------------------

function* collectAddedLines(
  context: AnalysisContext,
  filePattern: RegExp,
): IterableIterator<AddedLine> {
  for (const fileDiff of context.diffs) {
    if (!filePattern.test(fileDiff.filePath)) {
      continue;
    }

    const lineScanState: LineScanState = { insideBlockComment: false };

    for (const hunk of fileDiff.hunks) {
      const startingLine = parseHunkStartingLine(hunk.header);
      if (startingLine === null) {
        continue;
      }

      let currentLineNumber = startingLine;
      for (const line of hunk.lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const evidence = line.slice(1);
          yield {
            filePath: fileDiff.filePath,
            lineNumber: currentLineNumber,
            evidence,
            sanitizedContent: stripNonCodeContent(evidence, lineScanState),
            hunkHeader: hunk.header,
          };
          currentLineNumber += 1;
          continue;
        }

        if (line.startsWith(" ")) {
          stripNonCodeContent(line.slice(1), lineScanState);
          currentLineNumber += 1;
        }
      }
    }
  }
}

function stripNonCodeContent(sourceLine: string, lineScanState: LineScanState): string {
  let cursorIndex = 0;
  let sanitizedContent = "";

  while (cursorIndex < sourceLine.length) {
    const currentCharacter = sourceLine[cursorIndex];
    const nextCharacter = sourceLine[cursorIndex + 1];

    if (lineScanState.insideBlockComment) {
      if (currentCharacter === "*" && nextCharacter === "/") {
        lineScanState.insideBlockComment = false;
        cursorIndex += 2;
        continue;
      }

      cursorIndex += 1;
      continue;
    }

    if (currentCharacter === "/" && nextCharacter === "*") {
      lineScanState.insideBlockComment = true;
      cursorIndex += 2;
      continue;
    }

    if (currentCharacter === "/" && nextCharacter === "/") {
      break;
    }

    if (
      currentCharacter === "\"" ||
      currentCharacter === "'" ||
      currentCharacter === "`"
    ) {
      cursorIndex = skipStringLiteral(sourceLine, cursorIndex, currentCharacter);
      continue;
    }

    sanitizedContent += currentCharacter ?? "";
    cursorIndex += 1;
  }

  return sanitizedContent;
}

function skipStringLiteral(
  sourceLine: string,
  startIndex: number,
  quoteCharacter: string,
): number {
  let cursorIndex = startIndex + 1;

  while (cursorIndex < sourceLine.length) {
    const currentCharacter = sourceLine[cursorIndex];
    if (currentCharacter === "\\") {
      cursorIndex += 2;
      continue;
    }

    if (currentCharacter === quoteCharacter) {
      return cursorIndex + 1;
    }

    cursorIndex += 1;
  }

  return cursorIndex;
}

function buildManualReplacementCandidate(
  evidence: string,
  sanitizedContent: string,
): string | null {
  if (NON_CODE_MARKER_PATTERN.test(evidence) && sanitizedContent !== evidence) {
    return null;
  }

  let replacementCandidate = evidence;
  replacementCandidate = replacementCandidate.replace(/\bas\s+any\b/g, "as unknown");
  replacementCandidate = replacementCandidate.replace(/:\s*any\b/g, ": unknown");
  replacementCandidate = replacementCandidate.replace(/<\s*any\s*>/g, "<unknown>");
  replacementCandidate = replacementCandidate.replace(/\bany\s*\[\s*\]/g, "unknown[]");
  replacementCandidate = replacementCandidate.replace(/\bArray\s*<\s*any\s*>/g, "Array<unknown>");
  replacementCandidate = replacementCandidate.replace(
    /\bReadonlyArray\s*<\s*any\s*>/g,
    "ReadonlyArray<unknown>",
  );
  replacementCandidate = replacementCandidate.replace(
    /\bPromise\s*<\s*any\s*>/g,
    "Promise<unknown>",
  );

  return replacementCandidate === evidence ? null : replacementCandidate;
}

function buildUnsafeAnyRecommendation(suggestedReplacement: string | null): string {
  const baseRecommendation =
    "Explicit any is disallowed. Replace with a concrete type, unknown, or a constrained generic, then add the required narrowing. This is a manual change and no automatic patch is applied because unknown substitutions can require follow-up edits to keep compilation safe.";

  if (!suggestedReplacement) {
    return baseRecommendation;
  }

  return `${baseRecommendation} Possible manual starting point: \`${suggestedReplacement}\``;
}

// ---------------------------------------------------------------------------
// non-null assertion AST helpers
// ---------------------------------------------------------------------------

function isDefiniteAssignmentContext(node: ts.Node): boolean {
  if (!node.parent || !ts.isPropertyDeclaration(node.parent)) return false; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- parent may be undefined at AST root
  return node.parent.exclamationToken !== undefined;
}

function buildNonNullAssertionReplacement(
  evidence: string,
  scriptKind: ts.ScriptKind,
): string | null {
  const sourceFile = ts.createSourceFile(
    "added-line.ts",
    evidence,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const exclamationIndexes: number[] = [];

  const visitNode = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) {
      exclamationIndexes.push(node.expression.end);
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sourceFile);

  if (exclamationIndexes.length === 0) {
    return null;
  }

  let result = evidence;
  for (const exclamationIndex of [...exclamationIndexes].sort((left, right) => right - left)) {
    if (result[exclamationIndex] === "!") {
      result = result.slice(0, exclamationIndex) + result.slice(exclamationIndex + 1);
    }
  }

  return result === evidence ? null : result;
}

// ---------------------------------------------------------------------------
// Nested ternary helpers
// ---------------------------------------------------------------------------

function containsNestedConditional(node: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) return containsNestedConditional(node.expression);
  return false;
}

function isInsideJsxExpression(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent as ts.Node | undefined;
  while (current) {
    if (ts.isJsxExpression(current)) return true;
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Negated condition helpers
// ---------------------------------------------------------------------------

function isNegatedExpression(node: ts.Expression): boolean {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return isNegatedExpression(node.expression);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Optional chaining helpers
// ---------------------------------------------------------------------------

function isOptionalChainNode(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken) return true;
  if (ts.isElementAccessExpression(node) && node.questionDotToken) return true;
  if (ts.isCallExpression(node) && node.questionDotToken) return true;
  return false;
}

function countOptionalChainDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node = node;

  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    if (current.questionDotToken) depth += 1;
    current = current.expression;
  }

  return depth;
}
