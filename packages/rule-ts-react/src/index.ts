import type { AnalysisContext, Finding, PatchPreview, StatelessRule } from "@mergewise/shared-types";

const TYPE_SCRIPT_REACT_FILE_PATTERN = /\.(ts|tsx)$/i;
const TYPE_SCRIPT_JSX_FILE_PATTERN = /\.tsx$/i;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const NON_CODE_MARKER_PATTERN = /(?:'|"|`|\/\/|\/\*)/;

const UNSAFE_ANY_RULE_IDENTIFIER = "ts-react/no-unsafe-any";
const UNSAFE_ANY_PATTERN = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|\bReadonlyArray\s*<\s*any\s*>|\bPromise\s*<\s*any\s*>)/;

const NON_NULL_ASSERTION_RULE_IDENTIFIER = "ts-react/no-non-null-assertion";
const NON_NULL_ASSERTION_PATTERN = /([)\]}\w$])!\s*(?=[.\[\]),;:?]|$)/;

const ARRAY_INDEX_KEY_RULE_IDENTIFIER = "ts-react/no-array-index-key";
const ARRAY_INDEX_KEY_PATTERN = /\bkey\s*=\s*{\s*(?:index|idx|i)\s*}/;

const DEBUGGER_STATEMENT_RULE_IDENTIFIER = "ts-react/no-debugger-statement";
const DEBUGGER_STATEMENT_PATTERN = /\bdebugger\b\s*;?/;
const ONLY_DEBUGGER_STATEMENT_PATTERN = /^\s*debugger\s*;?\s*$/;

type LineScanState = {
  insideBlockComment: boolean;
};

type AddedLine = {
  filePath: string;
  lineNumber: number;
  evidence: string;
  sanitizedContent: string;
  hunkHeader: string;
};

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
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_REACT_FILE_PATTERN)) {
      if (!UNSAFE_ANY_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      const suggestedReplacement = buildManualReplacementCandidate(
        addedLine.evidence,
        addedLine.sanitizedContent,
      );

      findings.push(
        buildFinding(context, {
          ruleId: UNSAFE_ANY_RULE_IDENTIFIER,
          category: "safety",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation: buildUnsafeAnyRecommendation(suggestedReplacement),
          confidence: 0.95,
        }),
      );
    }

    return findings;
  },
};

/**
 * Stateless rule that flags non-null assertions (`!`) in changed TypeScript and React files.
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
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_REACT_FILE_PATTERN)) {
      if (!NON_NULL_ASSERTION_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      const replacementLine = addedLine.evidence.replace(NON_NULL_ASSERTION_PATTERN, "$1");
      const patchPreview =
        replacementLine === addedLine.evidence
          ? undefined
          : buildPatchPreview(addedLine.hunkHeader, addedLine.evidence, replacementLine);

      findings.push(
        buildFinding(context, {
          ruleId: NON_NULL_ASSERTION_RULE_IDENTIFIER,
          category: "safety",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation:
            "Avoid non-null assertions. Add an explicit null guard or narrow the value before access so runtime null cases stay safe.",
          patchPreview,
          confidence: 0.92,
        }),
      );
    }

    return findings;
  },
};

/**
 * Stateless rule that flags JSX `key` props backed by array indexes.
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
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_JSX_FILE_PATTERN)) {
      if (!ARRAY_INDEX_KEY_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      findings.push(
        buildFinding(context, {
          ruleId: ARRAY_INDEX_KEY_RULE_IDENTIFIER,
          category: "idiomatic",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation:
            "Do not use array index as a React key. Use a stable identifier from the item data so reorder and insertion operations keep component state aligned.",
          confidence: 0.9,
        }),
      );
    }

    return findings;
  },
};

/**
 * Stateless rule that flags debugger statements in changed TypeScript and React files.
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
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_REACT_FILE_PATTERN)) {
      if (!DEBUGGER_STATEMENT_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      const patchPreview = buildDebuggerPatchPreview(
        addedLine.hunkHeader,
        addedLine.evidence,
        addedLine.sanitizedContent,
      );

      findings.push(
        buildFinding(context, {
          ruleId: DEBUGGER_STATEMENT_RULE_IDENTIFIER,
          category: "clean",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation:
            "Remove debugger statements before merge. Keep temporary debugging local and use logging or tests for persistent diagnostics.",
          patchPreview,
          confidence: 0.97,
        }),
      );
    }

    return findings;
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
];

/**
 * Collects added lines for files matching one path pattern.
 *
 * @param context - Rule execution context with changed file hunks.
 * @param filePattern - Pattern used to select relevant files.
 * @returns Added line records with line numbers and sanitized content.
 */
function collectAddedLines(context: AnalysisContext, filePattern: RegExp): readonly AddedLine[] {
  const addedLines: AddedLine[] = [];

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
          addedLines.push({
            filePath: fileDiff.filePath,
            lineNumber: currentLineNumber,
            evidence,
            sanitizedContent: stripNonCodeContent(evidence, lineScanState),
            hunkHeader: hunk.header,
          });
          currentLineNumber += 1;
          continue;
        }

        if (line.startsWith(" ")) {
          currentLineNumber += 1;
        }
      }
    }
  }

  return addedLines;
}

/**
 * Parses the starting target line number from a unified diff hunk header.
 *
 * @param header - Unified diff hunk header.
 * @returns Added-side starting line number or `null` when parsing fails.
 */
function parseHunkStartingLine(header: string): number | null {
  const headerMatch = HUNK_HEADER_PATTERN.exec(header);
  if (!headerMatch) {
    return null;
  }

  const lineCapture = headerMatch[1];
  if (!lineCapture) {
    return null;
  }

  const parsedValue = Number.parseInt(lineCapture, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

/**
 * Removes string literal and comment text from one added source line.
 *
 * @param sourceLine - Added source line without leading diff marker.
 * @param lineScanState - Mutable scanner state for block comment continuity.
 * @returns Source content with non-code segments stripped.
 */
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

    sanitizedContent += currentCharacter;
    cursorIndex += 1;
  }

  return sanitizedContent;
}

/**
 * Advances the cursor past one quoted string literal, handling escape sequences.
 *
 * @param sourceLine - Added source line without leading diff marker.
 * @param startIndex - Index of the opening quote character.
 * @param quoteCharacter - Quote delimiter used by the literal.
 * @returns Next index after the closing quote or end-of-line.
 */
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

/**
 * Builds a manual replacement starting point for explicit `any` usages.
 *
 * @param evidence - Original added source line.
 * @param sanitizedContent - Source line with string and comment segments removed.
 * @returns Suggested manual replacement or `null` when no candidate is available.
 */
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

/**
 * Builds recommendation text for one `any` finding.
 *
 * @param suggestedReplacement - Optional manual replacement candidate.
 * @returns Recommendation text with explicit non-automatic guidance.
 */
function buildUnsafeAnyRecommendation(suggestedReplacement: string | null): string {
  const baseRecommendation =
    "Explicit any is disallowed. Replace with a concrete type, unknown, or a constrained generic, then add the required narrowing. This is a manual change and no automatic patch is applied because unknown substitutions can require follow-up edits to keep compilation safe.";

  if (!suggestedReplacement) {
    return baseRecommendation;
  }

  return `${baseRecommendation} Possible manual starting point: \`${suggestedReplacement}\``;
}

/**
 * Builds a patch preview for one-line suggestions.
 *
 * @param hunkHeader - Unified diff hunk header.
 * @param removedLine - Original added source line.
 * @param addedLine - Suggested replacement line.
 * @returns Structured patch preview.
 */
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

/**
 * Builds debugger-specific patch previews only when the full line is the statement.
 *
 * @param hunkHeader - Unified diff hunk header.
 * @param evidence - Original added source line.
 * @param sanitizedContent - Line content with comments and strings removed.
 * @returns Patch preview when safe, otherwise `undefined`.
 */
function buildDebuggerPatchPreview(
  hunkHeader: string,
  evidence: string,
  sanitizedContent: string,
): PatchPreview | undefined {
  if (!ONLY_DEBUGGER_STATEMENT_PATTERN.test(sanitizedContent)) {
    return undefined;
  }

  return {
    hunkHeader,
    removedLines: [evidence],
    addedLines: [],
  };
}

/**
 * Builds one finding with shared pull request attribution fields.
 *
 * @param context - Rule execution context.
 * @param findingCore - Rule-specific finding fields.
 * @returns Structured finding payload.
 */
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
