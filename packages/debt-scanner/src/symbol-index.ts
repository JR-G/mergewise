import { relative } from "node:path";
import ts from "typescript";
import { toFilePath, toLineNumber, type SymbolEntry } from "@mergewise/shared-types";

const TSX_PATTERN = /\.tsx$/i;
const MAX_SYMBOLS_PER_FILE = 200;
const MAX_SYMBOL_NAME_LENGTH = 120;

interface SymbolAccumulator {
  readonly entries: SymbolEntry[];
  readonly seenKeys: Set<string>;
}

/**
 * Builds a bounded top-level symbol index for repository files.
 *
 * @remarks
 * The index is used by the reviewer to discover existing helpers, hooks,
 * types, and constants before suggesting new abstractions.
 */
export async function indexSymbols(
  filePaths: readonly string[],
  repoPath: string,
  concurrency = 50,
): Promise<readonly SymbolEntry[]> {
  const batches = chunk(filePaths, concurrency);
  const symbols: SymbolEntry[] = [];

  for (const batch of batches) {
    const results = await Promise.all(batch.map((filePath) => indexFileSymbols(filePath, repoPath)));
    for (const result of results) {
      symbols.push(...result);
    }
  }

  return symbols;
}

async function indexFileSymbols(
  filePath: string,
  repoPath: string,
): Promise<readonly SymbolEntry[]> {
  const fileContent = await readFileContent(filePath);
  if (fileContent === null) return [];

  const relativePath = toFilePath(relative(repoPath, filePath));
  const scriptKind = TSX_PATTERN.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true, scriptKind);
  const accumulator: SymbolAccumulator = { entries: [], seenKeys: new Set() };

  for (const statement of sourceFile.statements) {
    if (accumulator.entries.length >= MAX_SYMBOLS_PER_FILE) {
      break;
    }
    collectStatementSymbols(statement, sourceFile, relativePath, accumulator);
  }

  return accumulator.entries;
}

function collectStatementSymbols(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
  relativePath: ReturnType<typeof toFilePath>,
  accumulator: SymbolAccumulator,
): void {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    pushNamedSymbol({
      accumulator,
      sourceFile,
      relativePath,
      name: statement.name.text,
      kind: "function",
      nameNode: statement.name,
      statement,
    });
    return;
  }

  if (ts.isClassDeclaration(statement) && statement.name) {
    pushNamedSymbol({
      accumulator,
      sourceFile,
      relativePath,
      name: statement.name.text,
      kind: "class",
      nameNode: statement.name,
      statement,
    });
    return;
  }

  if (ts.isInterfaceDeclaration(statement)) {
    pushNamedSymbol({
      accumulator,
      sourceFile,
      relativePath,
      name: statement.name.text,
      kind: "interface",
      nameNode: statement.name,
      statement,
    });
    return;
  }

  if (ts.isTypeAliasDeclaration(statement)) {
    pushNamedSymbol({
      accumulator,
      sourceFile,
      relativePath,
      name: statement.name.text,
      kind: "type",
      nameNode: statement.name,
      statement,
    });
    return;
  }

  if (ts.isVariableStatement(statement)) {
    collectVariableSymbols(statement, sourceFile, relativePath, accumulator);
  }
}

function collectVariableSymbols(
  statement: ts.VariableStatement,
  sourceFile: ts.SourceFile,
  relativePath: ReturnType<typeof toFilePath>,
  accumulator: SymbolAccumulator,
): void {
  const exported = hasExportModifier(statement);
  const symbolKind = isConstDeclaration(statement) ? "constant" : "variable";

  for (const declaration of statement.declarationList.declarations) {
    if (accumulator.entries.length >= MAX_SYMBOLS_PER_FILE) {
      break;
    }
    if (!ts.isIdentifier(declaration.name)) {
      continue;
    }
    pushSymbol(accumulator, {
      name: declaration.name.text,
      kind: symbolKind,
      file: relativePath,
      line: getLineNumber(sourceFile, declaration.name),
      exported,
    });
  }
}

function pushNamedSymbol(
  input: {
    readonly accumulator: SymbolAccumulator;
    readonly sourceFile: ts.SourceFile;
    readonly relativePath: ReturnType<typeof toFilePath>;
    readonly name: string;
    readonly kind: SymbolEntry["kind"];
    readonly nameNode: ts.Node;
    readonly statement: ts.Statement;
  },
): void {
  pushSymbol(input.accumulator, {
    name: input.name,
    kind: input.kind,
    file: input.relativePath,
    line: getLineNumber(input.sourceFile, input.nameNode),
    exported: hasExportModifier(input.statement),
  });
}

function pushSymbol(
  accumulator: SymbolAccumulator,
  symbol: SymbolEntry,
): void {
  const trimmedName = symbol.name.trim();
  if (trimmedName.length === 0) {
    return;
  }

  const cappedName = trimmedName.slice(0, MAX_SYMBOL_NAME_LENGTH);
  const dedupeKey = `${symbol.file}:${String(symbol.line)}:${cappedName}:${symbol.kind}`;
  if (accumulator.seenKeys.has(dedupeKey)) {
    return;
  }

  accumulator.entries.push({
    ...symbol,
    name: cappedName,
  });
  accumulator.seenKeys.add(dedupeKey);
}

function getLineNumber(sourceFile: ts.SourceFile, node: ts.Node): ReturnType<typeof toLineNumber> {
  return toLineNumber(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function isConstDeclaration(statement: ts.VariableStatement): boolean {
  return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
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
