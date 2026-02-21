import type { AnalysisContext, FileDiff } from "@mergewise/shared-types";
import ts from "typescript";

const TYPE_SCRIPT_FILE_PATTERN = /\.(ts|tsx)$/i;
const TYPE_SCRIPT_JSX_FILE_PATTERN = /\.tsx$/i;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

export interface ParsedFile {
  readonly filePath: string;
  readonly sourceFile: ts.SourceFile;
  readonly addedLineMap: ReadonlyMap<number, AddedLineInfo>;
}

export interface AddedLineInfo {
  readonly lineNumber: number;
  readonly evidence: string;
  readonly hunkHeader: string;
  readonly sourceOffset: number;
}

export interface AstFinding {
  readonly node: ts.Node;
  readonly lineNumber: number;
  readonly evidence: string;
  readonly hunkHeader: string;
}

export function parseChangedFiles(
  context: AnalysisContext,
  filePattern: RegExp = TYPE_SCRIPT_FILE_PATTERN,
): ParsedFile[] {
  const results: ParsedFile[] = [];

  for (const fileDiff of context.diffs) {
    if (!filePattern.test(fileDiff.filePath)) {
      continue;
    }

    const parsed = parseFileDiff(fileDiff);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

function parseFileDiff(fileDiff: FileDiff): ParsedFile | null {
  const sourceLines: string[] = [];
  const addedLineMap = new Map<number, AddedLineInfo>();
  let sourceLineIndex = 0;

  for (const hunk of fileDiff.hunks) {
    const startingLine = parseHunkStartingLine(hunk.header);
    if (startingLine === null) {
      continue;
    }

    let currentLineNumber = startingLine;
    for (const line of hunk.lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        const evidence = line.slice(1);
        sourceLines.push(evidence);
        addedLineMap.set(sourceLineIndex, {
          lineNumber: currentLineNumber,
          evidence,
          hunkHeader: hunk.header,
          sourceOffset: sourceLineIndex,
        });
        sourceLineIndex += 1;
        currentLineNumber += 1;
        continue;
      }

      if (line.startsWith(" ")) {
        sourceLines.push(line.slice(1));
        sourceLineIndex += 1;
        currentLineNumber += 1;
      }
    }
  }

  if (sourceLines.length === 0) {
    return null;
  }

  const sourceText = sourceLines.join("\n");
  const scriptKind = fileDiff.filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;

  const sourceFile = ts.createSourceFile(
    fileDiff.filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  return { filePath: fileDiff.filePath, sourceFile, addedLineMap };
}

export function findAddedNodesWhere(
  parsedFile: ParsedFile,
  predicate: (node: ts.Node) => boolean,
): AstFinding[] {
  const findings: AstFinding[] = [];

  const visit = (node: ts.Node): void => {
    if (predicate(node)) {
      const sourceLine = parsedFile.sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const lineInfo = parsedFile.addedLineMap.get(sourceLine.line);
      if (lineInfo) {
        findings.push({
          node,
          lineNumber: lineInfo.lineNumber,
          evidence: lineInfo.evidence,
          hunkHeader: lineInfo.hunkHeader,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsedFile.sourceFile);
  return findings;
}

export function isOnAddedLine(parsedFile: ParsedFile, node: ts.Node): AddedLineInfo | null {
  const sourceLine = parsedFile.sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return parsedFile.addedLineMap.get(sourceLine.line) ?? null;
}

export function parseHunkStartingLine(header: string): number | null {
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

export { TYPE_SCRIPT_FILE_PATTERN, TYPE_SCRIPT_JSX_FILE_PATTERN };
