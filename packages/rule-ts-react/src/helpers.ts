import type { AnalysisContext, Finding, PatchPreview } from "@mergewise/shared-types";
import { parseHunkStartingLine } from "./ast";

/**
 * Matches the opening token of a string literal or comment within source code.
 *
 * Detects single-quote, double-quote, backtick, line-comment (`//`), and
 * block-comment open sequences. Used as a fast pre-check to decide whether a
 * line contains non-code content worth stripping via {@link stripNonCodeContent}.
 */
export const NON_CODE_MARKER_PATTERN = /(?:'|"|`|\/\/|\/\*)/;

interface LineScanState {
  insideBlockComment: boolean;
}

/**
 * A single added line from a diff/patch hunk.
 */
export interface AddedLine {
  /** Path to the file containing the added line. */
  filePath: string;
  /** Line number in the target file. */
  lineNumber: number;
  /** Original added text from the diff. */
  evidence: string;
  /** Content with comments and string literals stripped. */
  sanitizedContent: string;
  /** Diff hunk header string for context. */
  hunkHeader: string;
}

/**
 * Constructs a complete {@link Finding} from an analysis context and core finding fields.
 *
 * @param context - Analysis context providing PR metadata.
 * @param findingCore - Core finding fields including rule, location, and confidence.
 * @returns A fully populated finding with a deterministic ID.
 */
export function buildFinding(
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

/**
 * Constructs a single-line {@link PatchPreview} from hunk components.
 *
 * @param hunkHeader - Diff hunk header for context.
 * @param removedLine - The line being replaced.
 * @param addedLine - The suggested replacement line.
 * @returns A patch preview with one removed and one added line.
 */
export function buildPatchPreview(
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
 * Yields added lines from diff hunks whose file path matches a given pattern.
 *
 * Iterates each file diff in the analysis context, parses hunk headers via
 * {@link parseHunkStartingLine}, and delegates line-level extraction to an
 * internal generator. A shared {@link LineScanState} is maintained per file
 * to track block-comment boundaries across hunks.
 *
 * @param context - Analysis context containing parsed diffs.
 * @param filePattern - Regular expression to filter file paths.
 * @returns Iterator of added lines with sanitised content and hunk metadata.
 */
export function* collectAddedLines(
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

      yield* collectHunkAddedLines(hunk.lines, {
        filePath: fileDiff.filePath,
        startingLine,
        hunkHeader: hunk.header,
        lineScanState,
      });
    }
  }
}

interface HunkContext {
  readonly filePath: string;
  readonly startingLine: number;
  readonly hunkHeader: string;
  readonly lineScanState: LineScanState;
}

function* collectHunkAddedLines(
  lines: readonly string[],
  ctx: HunkContext,
): IterableIterator<AddedLine> {
  let currentLineNumber = ctx.startingLine;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const evidence = line.slice(1);
      yield {
        filePath: ctx.filePath,
        lineNumber: currentLineNumber,
        evidence,
        sanitizedContent: stripNonCodeContent(evidence, ctx.lineScanState),
        hunkHeader: ctx.hunkHeader,
      };
      currentLineNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      stripNonCodeContent(line.slice(1), ctx.lineScanState);
      currentLineNumber += 1;
    }
  }
}

/**
 * Strips comments and string literals from a source line, returning only executable code content.
 *
 * Handles line comments, block comments, and string literals (single-quoted,
 * double-quoted, and template). Block-comment state is tracked across calls
 * via {@link LineScanState} so multi-line comments spanning hunks are handled
 * correctly. String literals are skipped using {@link skipStringLiteral}.
 *
 * @param sourceLine - Raw source line to sanitise.
 * @param lineScanState - Mutable state tracking whether a block comment is open;
 *   updated as a side-effect when block-comment open or close sequences are encountered.
 * @returns The source line with comments and string literals removed.
 */
export function stripNonCodeContent(sourceLine: string, lineScanState: LineScanState): string {
  let cursorIndex = 0;
  let sanitizedContent = "";

  while (cursorIndex < sourceLine.length) {
    const currentCharacter = sourceLine[cursorIndex];
    const nextCharacter = sourceLine[cursorIndex + 1];

    if (lineScanState.insideBlockComment) {
      const closesBlockComment = currentCharacter === "*" && nextCharacter === "/";
      lineScanState.insideBlockComment = closesBlockComment
        ? false
        : lineScanState.insideBlockComment;
      cursorIndex += closesBlockComment ? 2 : 1;
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

/**
 * Advances a cursor past a string literal, returning the index after the closing quote.
 *
 * Handles escape sequences (backslash followed by any character) and, for
 * backtick-quoted template literals, delegates `${…}` expressions to
 * {@link skipTemplateExpression} so nested strings and braces are handled
 * correctly.
 *
 * @param sourceLine - Full source line containing the string literal.
 * @param startIndex - Index of the opening quote character.
 * @param quoteCharacter - The quote character (`"`, `'`, or backtick).
 * @returns Index immediately after the closing quote, or the end of the line
 *   if the string is unterminated.
 */
export function skipStringLiteral(
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

    if (
      quoteCharacter === "`" &&
      currentCharacter === "$" &&
      sourceLine[cursorIndex + 1] === "{"
    ) {
      cursorIndex = skipTemplateExpression(sourceLine, cursorIndex + 2);
      continue;
    }

    if (currentCharacter === quoteCharacter) {
      return cursorIndex + 1;
    }

    cursorIndex += 1;
  }

  return cursorIndex;
}

function skipTemplateExpression(sourceLine: string, startIndex: number): number {
  let cursorIndex = startIndex;
  let braceDepth = 1;

  while (cursorIndex < sourceLine.length && braceDepth > 0) {
    const currentCharacter = sourceLine[cursorIndex];

    if (currentCharacter === "{") {
      braceDepth += 1;
      cursorIndex += 1;
      continue;
    }

    if (currentCharacter === "}" && --braceDepth === 0) {
      return cursorIndex + 1;
    }
    if (currentCharacter === "}") {
      cursorIndex += 1;
      continue;
    }

    if (
      currentCharacter === "\"" ||
      currentCharacter === "'" ||
      currentCharacter === "`"
    ) {
      cursorIndex = skipStringLiteral(sourceLine, cursorIndex, currentCharacter);
      continue;
    }

    cursorIndex += 1;
  }

  return cursorIndex;
}

