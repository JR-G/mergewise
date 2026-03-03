import { dirname, resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import ts from "typescript";
import type { DebtEdge, DebtGraph, DebtNode } from "./graph-types.ts";

const TS_EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * Builds a dependency graph from import declarations in all analysed files.
 *
 * @param nodes - File-level debt nodes produced by the AST analyser.
 * @param repoPath - Absolute path to the repository root.
 * @returns A `DebtGraph` with the provided nodes and import edges.
 */
export async function buildGraph(
  nodes: readonly DebtNode[],
  repoPath: string,
): Promise<DebtGraph> {
  const nodeMap = new Map<string, DebtNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const knownPaths = new Set(nodeMap.keys());
  const edges: DebtEdge[] = [];

  for (const node of nodes) {
    const absolutePath = resolve(repoPath, node.filePath);
    const imports = await extractImports(absolutePath);

    for (const importSpecifier of imports) {
      const resolvedTarget = resolveImport(importSpecifier, absolutePath, repoPath, knownPaths);
      if (resolvedTarget && resolvedTarget !== node.id) {
        edges.push({
          source: node.id,
          target: resolvedTarget,
          kind: "imports",
        });
      }
    }
  }

  return { nodes: nodeMap, edges };
}

async function extractImports(filePath: string): Promise<readonly string[]> {
  let content: string;
  try {
    const file = Bun.file(filePath);
    content = await file.text();
  } catch {
    return [];
  }

  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

  const imports: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push(statement.moduleSpecifier.text);
    }
  }

  return imports;
}

function resolveImport(
  specifier: string,
  fromFile: string,
  repoPath: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;

  const fromDir = dirname(fromFile);
  const resolved = resolve(fromDir, specifier);

  for (const extension of TS_EXTENSIONS) {
    const candidate = resolved + extension;
    const relativePath = relative(repoPath, candidate);
    if (knownPaths.has(relativePath)) return relativePath;
  }

  const exactRelative = relative(repoPath, resolved);
  if (knownPaths.has(exactRelative)) return exactRelative;

  for (const extension of TS_EXTENSIONS) {
    const candidate = resolved + extension;
    if (existsSync(candidate)) {
      return relative(repoPath, candidate);
    }
  }

  return null;
}
