import type { AnalysisContext, Finding, PatchPreview } from "@mergewise/shared-types";
import { parseHunkStartingLine } from "./ast";

const NON_CODE_MARKER_PATTERN = /(?:'|"|`|\/\/|\/\*)/;

interface LineScanState {
  insideBlockComment: boolean;
}

export interface AddedLine {
  filePath: string;
  lineNumber: number;
  evidence: string;
  sanitizedContent: string;
  hunkHeader: string;
}

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

    if (currentCharacter === quoteCharacter) {
      return cursorIndex + 1;
    }

    cursorIndex += 1;
  }

  return cursorIndex;
}

export { NON_CODE_MARKER_PATTERN };
