import type { StructuralSignals } from "@mergewise/llm-reviewer";
import { relative } from "node:path";
import ts from "typescript";
import type { DebtNode } from "./graph-types.ts";

const TSX_PATTERN = /\.tsx$/i;

const HOOK_PATTERN = /\buse(?:State|Effect|Memo|Callback|Ref|Reducer|Context)\s*\(/g;
const CLASS_DECLARATION_PATTERN = /(?:^|\s)class\s+\w+/;
const TYPE_ASSERTION_PATTERN = /\bas\s+\w/g;

interface FunctionInfo {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly parameterCount: number;
}

/**
 * Parses a single file and extracts structural signals and declaration info.
 *
 * @param filePath - Absolute path to the file.
 * @param repoPath - Absolute path to the repository root.
 * @returns A `DebtNode` for the file, or `null` if the file cannot be read.
 */
export async function analyseFile(
  filePath: string,
  repoPath: string,
): Promise<DebtNode | null> {
  const fileContent = await readFileContent(filePath);
  if (fileContent === null) return null;

  const relativePath = relative(repoPath, filePath);
  const lines = fileContent.split("\n");
  const lineCount = lines.length;

  const scriptKind = TSX_PATTERN.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true, scriptKind);

  const functions = extractFunctions(sourceFile);
  const signals = extractSignalsFromLines(lines, functions);

  const hasComponent = TSX_PATTERN.test(filePath) && signals.hookCount > 0;
  const kind = signals.classCount > 0 ? "class" as const : hasComponent ? "component" as const : "file" as const;

  return {
    id: relativePath,
    kind,
    filePath: relativePath,
    signals,
    lineCount,
    centrality: 0,
  };
}

/**
 * Analyses multiple files in parallel with bounded concurrency.
 */
export async function analyseFiles(
  filePaths: readonly string[],
  repoPath: string,
  concurrency = 50,
): Promise<DebtNode[]> {
  const nodes: DebtNode[] = [];
  const batches = chunk(filePaths, concurrency);

  for (const batch of batches) {
    const results = await Promise.all(batch.map((filePath) => analyseFile(filePath, repoPath)));
    for (const result of results) {
      if (result) nodes.push(result);
    }
  }

  return nodes;
}

function extractFunctions(sourceFile: ts.SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      functions.push(buildFunctionInfo(sourceFile, node.name.text, node));
    }

    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      functions.push(buildFunctionInfo(sourceFile, node.name.text, node));
    }

    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      functions.push(buildFunctionInfo(sourceFile, node.parent.name.text, node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return functions;
}

function buildFunctionInfo(
  sourceFile: ts.SourceFile,
  name: string,
  node: ts.Node,
): FunctionInfo {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;

  let parameterCount = 0;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    parameterCount = node.parameters.length;
  }

  return { name, startLine, endLine, parameterCount };
}

function extractSignalsFromLines(
  lines: readonly string[],
  functions: readonly FunctionInfo[],
): StructuralSignals {
  let hookCount = 0;
  let importCount = 0;
  let maxNestingDepth = 0;
  let currentDepth = 0;
  let classCount = 0;
  let typeAssertionCount = 0;
  let componentLineCount = 0;

  for (const line of lines) {
    if (/^\s*import\s/.test(line)) {
      importCount += 1;
      continue;
    }

    const hookMatches = line.match(HOOK_PATTERN);
    if (hookMatches) hookCount += hookMatches.length;

    if (CLASS_DECLARATION_PATTERN.test(line)) classCount += 1;

    const typeAssertionMatches = line.match(TYPE_ASSERTION_PATTERN);
    if (typeAssertionMatches) typeAssertionCount += typeAssertionMatches.length;

    const openers = (line.match(/[({]/g) ?? []).length;
    const closers = (line.match(/[)}]/g) ?? []).length;
    currentDepth += openers - closers;
    if (currentDepth > maxNestingDepth) maxNestingDepth = currentDepth;
    if (currentDepth < 0) currentDepth = 0;
  }

  componentLineCount = lines.length;

  const functionCount = functions.length;
  const maxFunctionLineCount = functions.reduce(
    (max, func) => Math.max(max, func.endLine - func.startLine + 1),
    0,
  );
  const maxParameterCount = functions.reduce(
    (max, func) => Math.max(max, func.parameterCount),
    0,
  );

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

async function readFileContent(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    return await file.text();
  } catch {
    return null;
  }
}

function chunk<T>(array: readonly T[], size: number): T[][] {
  const effectiveSize = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let index = 0; index < array.length; index += effectiveSize) {
    result.push(array.slice(index, index + effectiveSize));
  }
  return result;
}
