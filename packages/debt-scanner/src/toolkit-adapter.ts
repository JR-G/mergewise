import type { FileGraphContext, ReviewToolkit, ReusableSymbolMatch } from "@mergewise/llm-reviewer";
import type { FilePath, SymbolEntry, SymbolKind } from "@mergewise/shared-types";

import type { DebtGraph, HotspotEntry } from "./graph-types";
import { buildPrGraphContext } from "./graph-context";

const MAX_CALLERS = 50;
const DEFAULT_SYMBOL_LIMIT = 5;
const MAX_SYMBOL_LIMIT = 10;

interface Indexes {
  readonly reverseImports: ReadonlyMap<string, readonly string[]>;
  readonly forwardImports: ReadonlyMap<string, readonly string[]>;
}

interface SymbolSearchInput {
  readonly symbols: readonly SymbolEntry[];
  readonly indexes: Indexes;
  readonly filePath: FilePath;
  readonly query: string;
  readonly limit: number | undefined;
}

interface SymbolSearchContext {
  readonly currentFile: FilePath;
  readonly currentDirectory: string;
  readonly directImports: ReadonlySet<string>;
  readonly importedBy: ReadonlySet<string>;
}

/**
 * Builds a {@link ReviewToolkit} from a debt graph and hotspot entries.
 *
 * Maps the debt-scanner's graph context shape to the llm-reviewer's
 * expected `FileGraphContext` interface, capping caller lists to avoid
 * unbounded prompt injection.
 *
 * @param graph - The scored debt graph for the repository.
 * @param hotspots - Ranked hotspot entries from the most recent scan.
 * @returns A toolkit that the review pipeline can query per-file.
 */
export function buildReviewToolkit(
  graph: DebtGraph,
  hotspots: readonly HotspotEntry[],
  symbols: readonly SymbolEntry[] = [],
): ReviewToolkit {
  const indexes = buildIndexes(graph);

  return {
    getCallers(filePath: FilePath): FileGraphContext {
      const context = buildPrGraphContext([filePath], graph, hotspots);
      const fileContext = context.files[0];
      if (!fileContext) {
        return { filePath, callers: [], centrality: 0, isHotspot: false };
      }
      return {
        filePath: fileContext.filePath as FilePath,
        callers: fileContext.importedBy.slice(0, MAX_CALLERS) as FilePath[],
        centrality: fileContext.centralityScore,
        isHotspot: fileContext.isHotspot,
      };
    },
    findReusableSymbols(filePath: FilePath, query: string, limit?: number): readonly ReusableSymbolMatch[] {
      return searchReusableSymbols({ symbols, indexes, filePath, query, limit });
    },
  };
}

function buildIndexes(graph: DebtGraph): Indexes {
  const reverseImports = new Map<string, string[]>();
  const forwardImports = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== "imports") {
      continue;
    }

    const existingReverse = reverseImports.get(edge.target);
    if (existingReverse) {
      existingReverse.push(edge.source);
    } else {
      reverseImports.set(edge.target, [edge.source]);
    }

    const existingForward = forwardImports.get(edge.source);
    if (existingForward) {
      existingForward.push(edge.target);
    } else {
      forwardImports.set(edge.source, [edge.target]);
    }
  }

  return { reverseImports, forwardImports };
}

function searchReusableSymbols(input: SymbolSearchInput): readonly ReusableSymbolMatch[] {
  const trimmedQuery = input.query.trim();
  if (trimmedQuery.length === 0) {
    return [];
  }

  const cappedLimit = Math.max(1, Math.min(Math.floor(input.limit ?? DEFAULT_SYMBOL_LIMIT), MAX_SYMBOL_LIMIT));
  const queryTokens = tokenize(trimmedQuery);
  const searchContext: SymbolSearchContext = {
    currentFile: input.filePath,
    currentDirectory: directoryOf(input.filePath),
    directImports: new Set(input.indexes.forwardImports.get(input.filePath) ?? []),
    importedBy: new Set(input.indexes.reverseImports.get(input.filePath) ?? []),
  };

  const matches = input.symbols.flatMap((symbol): ReusableSymbolMatch[] => {
    const symbolTokens = tokenize(symbol.name);
    const sharedTokenCount = countSharedTokens(queryTokens, symbolTokens);
    const includesQuery = normalise(symbol.name).includes(normalise(trimmedQuery));
    const nameScore = sharedTokenCount * 20 + (includesQuery ? 15 : 0);

    if (nameScore === 0) {
      return [];
    }

    const relation = resolveRelation(symbol.file, searchContext);
    const relationScore = relation === "current-file"
      ? 20
      : relation === "imports"
        ? 14
        : relation === "imported-by"
          ? 10
          : relation === "same-directory"
            ? 6
            : 0;
    const exportedScore = symbol.exported ? 4 : 0;
    const kindScore = symbolKindBonus(symbol.kind);

    return [{
      name: symbol.name,
      kind: symbol.kind,
      filePath: symbol.file,
      line: symbol.line,
      exported: symbol.exported,
      relation,
      score: nameScore + relationScore + exportedScore + kindScore,
    }];
  });

  matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.filePath !== right.filePath) {
      return left.filePath.localeCompare(right.filePath);
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.name.localeCompare(right.name);
  });

  return matches.slice(0, cappedLimit);
}

function resolveRelation(
  symbolFile: FilePath,
  searchContext: SymbolSearchContext,
): ReusableSymbolMatch["relation"] {
  if (symbolFile === searchContext.currentFile) {
    return "current-file";
  }
  if (searchContext.directImports.has(symbolFile)) {
    return "imports";
  }
  if (searchContext.importedBy.has(symbolFile)) {
    return "imported-by";
  }
  if (directoryOf(symbolFile) === searchContext.currentDirectory) {
    return "same-directory";
  }
  return "repo";
}

function countSharedTokens(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) {
      count += 1;
    }
  }
  return count;
}

function tokenize(text: string): Set<string> {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
  return new Set(expanded);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function directoryOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  return lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
}

function symbolKindBonus(kind: SymbolKind): number {
  if (kind === "function" || kind === "class" || kind === "interface" || kind === "type") {
    return 2;
  }
  return 0;
}
