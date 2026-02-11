import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";

const RULE_IDENTIFIER = "ts-react/no-unsafe-any";
const TYPE_SCRIPT_REACT_FILE_PATTERN = /\.(ts|tsx)$/i;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const UNSAFE_ANY_PATTERN = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|\bReadonlyArray\s*<\s*any\s*>|\bPromise\s*<\s*any\s*>)/;
const NON_CODE_MARKER_PATTERN = /(?:'|"|`|\/\/|\/\*)/;

type LineScanState = {
  insideBlockComment: boolean;
};

/**
 * Stateless rule that flags explicit `any` usage in changed TypeScript and React files.
 */
export const unsafeAnyUsageRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: RULE_IDENTIFIER,
    name: "Unsafe any usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects explicit any usage in added TypeScript and TSX lines.",
  },
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    return collectUnsafeAnyFindings(context);
  },
};

/**
 * Deterministic list of stateless TypeScript and React rules for worker consumption.
 */
export const tsReactRules: readonly StatelessRule[] = [unsafeAnyUsageRule];

/**
 * Collects findings from added TypeScript and TSX lines that include explicit `any` type usage.
 *
 * @param context - Rule execution context with changed file hunks.
 * @returns Findings for lines containing explicit `any` type usage.
 */
function collectUnsafeAnyFindings(context: AnalysisContext): readonly Finding[] {
  const findings: Finding[] = [];

  for (const fileDiff of context.diffs) {
    if (!TYPE_SCRIPT_REACT_FILE_PATTERN.test(fileDiff.filePath)) {
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
          const addedContent = line.slice(1);
          const addedCodeOnlyContent = stripNonCodeContent(addedContent, lineScanState);
          if (UNSAFE_ANY_PATTERN.test(addedCodeOnlyContent)) {
            findings.push(
              buildFinding(
                context,
                fileDiff.filePath,
                currentLineNumber,
                addedContent,
                addedCodeOnlyContent,
              ),
            );
          }
          currentLineNumber += 1;
          continue;
        }

        if (line.startsWith(" ")) {
          currentLineNumber += 1;
        }
      }
    }
  }

  return findings;
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
 * Builds manual-only recommendation text for one `any` finding.
 *
 * @param suggestedReplacement - Optional manual replacement candidate.
 * @returns Recommendation text with explicit non-automatic guidance.
 */
function buildRecommendation(suggestedReplacement: string | null): string {
  const baseRecommendation =
    "Explicit any is disallowed. Replace with a concrete type, unknown, or a constrained generic, then add the required narrowing. This is a manual change and no automatic patch is applied because unknown substitutions can require follow-up edits to keep compilation safe.";

  if (!suggestedReplacement) {
    return baseRecommendation;
  }

  return `${baseRecommendation} Possible manual starting point: \`${suggestedReplacement}\``;
}

/**
 * Builds one finding for explicit `any` usage in an added line.
 *
 * @param context - Rule execution context.
 * @param filePath - Path of the changed file.
 * @param line - Line number in the added file version.
 * @param evidence - Original added source line.
 * @param sanitizedContent - Source line with string and comment segments removed.
 * @returns Structured finding payload.
 */
function buildFinding(
  context: AnalysisContext,
  filePath: string,
  line: number,
  evidence: string,
  sanitizedContent: string,
): Finding {
  const findingIdentifier = `${RULE_IDENTIFIER}:${context.pullRequest.repo}:${context.pullRequest.prNumber}:${filePath}:${line}`;
  const suggestedReplacement = buildManualReplacementCandidate(
    evidence,
    sanitizedContent,
  );

  return {
    findingId: findingIdentifier,
    installationId: context.pullRequest.installationId,
    repo: context.pullRequest.repo,
    prNumber: context.pullRequest.prNumber,
    language: "typescript",
    ruleId: RULE_IDENTIFIER,
    category: "safety",
    filePath,
    line,
    evidence,
    recommendation: buildRecommendation(suggestedReplacement),
    confidence: 0.95,
    status: "posted",
  };
}
