import type { AnalysisContext, FileDiff } from "@mergewise/shared-types";
import ts from "typescript";

export const TYPE_SCRIPT_FILE_PATTERN = /\.(ts|tsx)$/i;
export const TYPE_SCRIPT_JSX_FILE_PATTERN = /\.tsx$/i;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * Parsed AST representation of one changed file from a pull request diff.
 *
 * @remarks
 * Combines the TypeScript source file with a map that relates AST source
 * lines back to their original diff line numbers. Only lines present in
 * the diff hunks (added and context) are included in the source text.
 */
export interface ParsedFile {
  /** File path relative to repository root. */
  readonly filePath: string;
  /** TypeScript source file parsed from the concatenated hunk lines. */
  readonly sourceFile: ts.SourceFile;
  /** Map from zero-indexed source line to its diff metadata. Only added lines are present. */
  readonly addedLineMap: ReadonlyMap<number, AddedLineInfo>;
}

/**
 * Diff metadata for a single added line within a parsed file.
 *
 * @remarks
 * Stored in the `ParsedFile.addedLineMap` and used to attribute AST
 * findings back to the correct pull request line and hunk.
 */
export interface AddedLineInfo {
  /** One-indexed line number in the target file. */
  readonly lineNumber: number;
  /** Raw source text of the added line without the diff `+` prefix. */
  readonly evidence: string;
  /** Unified diff hunk header that contains this line. */
  readonly hunkHeader: string;
  /** Zero-indexed position of this line within the concatenated source text. */
  readonly sourceOffset: number;
}

/**
 * A single AST node that matched a rule predicate on an added diff line.
 *
 * @remarks
 * Returned by {@link findAddedNodesWhere} and carries enough context
 * for rule implementations to build findings without re-querying the AST.
 */
export interface AstFinding {
  /** AST node that matched the predicate. */
  readonly node: ts.Node;
  /** One-indexed line number in the target file. */
  readonly lineNumber: number;
  /** Raw source text of the added line. */
  readonly evidence: string;
  /** Unified diff hunk header that contains the line. */
  readonly hunkHeader: string;
}

const parseCache = new WeakMap<AnalysisContext, Map<string, ParsedFile[]>>();

/**
 * Parses changed files from an analysis context into TypeScript ASTs.
 *
 * @remarks
 * Results are memoised by context identity and file pattern so that
 * multiple rules sharing the same context avoid redundant parsing.
 * Each file's added and context lines are concatenated into a single
 * source text and parsed with the correct `ScriptKind` based on
 * file extension (`.tsx` uses `TSX`, everything else uses `TS`).
 *
 * @param context - Analysis context containing parsed file diffs.
 * @param filePattern - Regex to filter files by path. Defaults to all `.ts` and `.tsx` files.
 * @returns Parsed file representations for files matching the pattern.
 */
export function parseChangedFiles(
  context: AnalysisContext,
  filePattern: RegExp = TYPE_SCRIPT_FILE_PATTERN,
): ParsedFile[] {
  let contextCache = parseCache.get(context);
  if (!contextCache) {
    contextCache = new Map();
    parseCache.set(context, contextCache);
  }

  const cacheKey = `${filePattern.source}\0${filePattern.flags}`;
  const cached = contextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

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

  contextCache.set(cacheKey, results);
  return results;
}

/**
 * Parses one file diff into a TypeScript source file with added-line tracking.
 *
 * @remarks
 * Concatenates added lines (`+` prefix, excluding `+++`) and context lines
 * (space prefix) across all hunks into a single source text. Deleted lines
 * (`-` prefix) are skipped entirely. `sourceLineIndex` is a running counter
 * across all hunks (not reset between them), while `currentLineNumber` is
 * reinitialised from each hunk header. Hunks with unparseable headers are
 * silently ignored. Returns `null` when no source lines are collected.
 * `ScriptKind` is set to `TSX` for `.tsx` files (case-insensitive) and
 * `TS` for everything else.
 *
 * @param fileDiff - Parsed file diff from the analysis context.
 * @returns Parsed file with AST and line map, or `null` when empty.
 */
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
  const scriptKind = TYPE_SCRIPT_JSX_FILE_PATTERN.test(fileDiff.filePath)
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

/**
 * Walks the AST of a parsed file and returns findings for added-line nodes matching a predicate.
 *
 * @remarks
 * Performs a depth-first traversal of the source file's AST. For each node
 * that satisfies the predicate and falls on an added line (not a context line),
 * an `AstFinding` is emitted. Child nodes of matching nodes are still visited.
 *
 * @param parsedFile - Parsed file from {@link parseChangedFiles}.
 * @param predicate - Node test function. Return `true` to emit a finding for the node.
 * @returns Findings for all matching nodes on added lines.
 */
export function findAddedNodesWhere(
  parsedFile: ParsedFile,
  predicate: (node: ts.Node) => boolean,
): AstFinding[] {
  const findings: AstFinding[] = [];

  const visit = (node: ts.Node): void => {
    const matchesPredicate = predicate(node);
    const sourceLine = matchesPredicate
      ? parsedFile.sourceFile.getLineAndCharacterOfPosition(
        node.getStart(parsedFile.sourceFile),
      )
      : null;
    const lineInfo = sourceLine ? parsedFile.addedLineMap.get(sourceLine.line) : undefined;
    if (lineInfo) {
      findings.push({
        node,
        lineNumber: lineInfo.lineNumber,
        evidence: lineInfo.evidence,
        hunkHeader: lineInfo.hunkHeader,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(parsedFile.sourceFile);
  return findings;
}

/**
 * Returns added-line metadata for a node if it falls on an added diff line.
 *
 * @param parsedFile - Parsed file from {@link parseChangedFiles}.
 * @param node - AST node to check.
 * @returns Line info when the node starts on an added line, or `null` for context lines.
 */
export function isOnAddedLine(parsedFile: ParsedFile, node: ts.Node): AddedLineInfo | null {
  const sourceLine = parsedFile.sourceFile.getLineAndCharacterOfPosition(
    node.getStart(parsedFile.sourceFile),
  );
  return parsedFile.addedLineMap.get(sourceLine.line) ?? null;
}

/**
 * Parses the starting target line number from a unified diff hunk header.
 *
 * @param header - Unified diff hunk header (e.g. `@@ -10,5 +10,7 @@`).
 * @returns One-indexed starting line number on the added side, or `null` when parsing fails.
 */
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
