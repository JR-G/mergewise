import { describe, test, expect } from "bun:test";
import { toFilePath, toLineNumber, type SymbolEntry } from "@mergewise/shared-types";
import { buildReviewToolkit } from "./toolkit-adapter";
import type { DebtGraph, DebtNode, DebtEdge, HotspotEntry } from "./graph-types";

function makeNode(filePath: string, centrality: number): DebtNode {
  return {
    id: filePath,
    kind: "file",
    filePath,
    lineCount: 100,
    centrality,
    signals: {
      functionCount: 5,
      hookCount: 0,
      maxNestingDepth: 2,
      classCount: 0,
      maxParameterCount: 3,
      typeAssertionCount: 0,
      maxFunctionLineCount: 30,
      componentLineCount: 0,
      importCount: 3,
    },
  };
}

function makeGraph(nodes: DebtNode[], edges: DebtEdge[]): DebtGraph {
  const nodeMap = new Map(nodes.map((node) => [node.filePath, node]));
  return { nodes: nodeMap, edges };
}

function makeHotspot(filePath: string, score: number): HotspotEntry {
  return {
    nodeId: filePath,
    filePath,
    score,
    centrality: score,
    signalDensity: 1,
    lineCount: 100,
  };
}

function makeSymbol(
  name: string,
  filePath: string,
  overrides: Partial<SymbolEntry> = {},
): SymbolEntry {
  return {
    name,
    kind: "function",
    file: toFilePath(filePath),
    line: toLineNumber(10),
    exported: true,
    ...overrides,
  };
}

describe("buildReviewToolkit", () => {
  test("maps centralityScore to centrality and importedBy to callers", () => {
    const graph = makeGraph(
      [
        makeNode("src/core.ts", 0.75),
        makeNode("src/consumer-a.ts", 0.2),
        makeNode("src/consumer-b.ts", 0.1),
      ],
      [
        { source: "src/consumer-a.ts", target: "src/core.ts", kind: "imports" },
        { source: "src/consumer-b.ts", target: "src/core.ts", kind: "imports" },
      ],
    );

    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/core.ts"));

    expect(result.filePath).toBe(toFilePath("src/core.ts"));
    expect(result.centrality).toBe(0.75);
    expect(result.callers).toContain(toFilePath("src/consumer-a.ts"));
    expect(result.callers).toContain(toFilePath("src/consumer-b.ts"));
  });

  test("returns empty defaults for a file not in the graph", () => {
    const graph = makeGraph([], []);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/unknown.ts"));

    expect(result.filePath).toBe(toFilePath("src/unknown.ts"));
    expect(result.callers).toEqual([]);
    expect(result.centrality).toBe(0);
    expect(result.isHotspot).toBe(false);
  });

  test("caps callers at 50 entries", () => {
    const targetFile = toFilePath("src/popular.ts");
    const callerNodes = Array.from({ length: 60 }, (_, index) =>
      makeNode(`src/caller-${index}.ts`, 0.01),
    );
    const edges: DebtEdge[] = callerNodes.map((node) => ({
      source: node.filePath,
      target: targetFile,
      kind: "imports" as const,
    }));

    const graph = makeGraph([makeNode(targetFile, 0.9), ...callerNodes], edges);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(targetFile);

    expect(result.callers.length).toBe(50);
  });

  test("returns zero centrality for a node with centrality zero", () => {
    const graph = makeGraph([makeNode("src/leaf.ts", 0)], []);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/leaf.ts"));

    expect(result.centrality).toBe(0);
    expect(result.callers).toEqual([]);
  });

  test("returns empty callers and zero centrality for an empty graph", () => {
    const emptyGraph: DebtGraph = { nodes: new Map(), edges: [] };
    const toolkit = buildReviewToolkit(emptyGraph, []);
    const result = toolkit.getCallers!(toFilePath("src/anything.ts"));

    expect(result.filePath).toBe(toFilePath("src/anything.ts"));
    expect(result.callers).toEqual([]);
    expect(result.centrality).toBe(0);
    expect(result.isHotspot).toBe(false);
  });

  test("marks a file as a hotspot when present in hotspot entries", () => {
    const graph = makeGraph([makeNode("src/hot.ts", 0.85)], []);
    const hotspots = [makeHotspot("src/hot.ts", 0.85)];
    const toolkit = buildReviewToolkit(graph, hotspots);
    const result = toolkit.getCallers!(toFilePath("src/hot.ts"));

    expect(result.isHotspot).toBe(true);
  });

  test("marks a file as not a hotspot when absent from hotspot entries", () => {
    const graph = makeGraph([makeNode("src/cold.ts", 0.1)], []);
    const hotspots = [makeHotspot("src/other.ts", 0.9)];
    const toolkit = buildReviewToolkit(graph, hotspots);
    const result = toolkit.getCallers!(toFilePath("src/cold.ts"));

    expect(result.isHotspot).toBe(false);
  });

  test("only counts import edges as callers, ignoring other edge kinds", () => {
    const graph = makeGraph(
      [
        makeNode("src/base.ts", 0.5),
        makeNode("src/derived.ts", 0.3),
        makeNode("src/importer.ts", 0.2),
      ],
      [
        { source: "src/derived.ts", target: "src/base.ts", kind: "extends" },
        { source: "src/importer.ts", target: "src/base.ts", kind: "imports" },
      ],
    );

    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/base.ts"));

    expect(result.callers).toContain(toFilePath("src/importer.ts"));
    expect(result.callers).not.toContain(toFilePath("src/derived.ts"));
  });

  test("passes through negative centrality without clamping", () => {
    const graph = makeGraph([makeNode("src/neg.ts", -0.5)], []);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/neg.ts"));

    expect(result.centrality).toBe(-0.5);
  });

  test("passes through very large centrality values", () => {
    const graph = makeGraph([makeNode("src/huge.ts", Number.MAX_VALUE)], []);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/huge.ts"));

    expect(Number.isFinite(result.centrality)).toBe(true);
    expect(result.centrality).toBe(Number.MAX_VALUE);
  });

  test("passes through NaN centrality without coercing", () => {
    const graph = makeGraph([makeNode("src/nan.ts", NaN)], []);
    const toolkit = buildReviewToolkit(graph, []);
    const result = toolkit.getCallers!(toFilePath("src/nan.ts"));

    expect(result.centrality).toBeNaN();
  });

  test("finds reusable symbols from directly imported files first", () => {
    const graph = makeGraph(
      [
        makeNode("src/feature.ts", 0.7),
        makeNode("src/shared/hooks.ts", 0.4),
        makeNode("src/other.ts", 0.2),
      ],
      [
        { source: "src/feature.ts", target: "src/shared/hooks.ts", kind: "imports" },
      ],
    );
    const toolkit = buildReviewToolkit(graph, [], [
      makeSymbol("useUserFilters", "src/shared/hooks.ts"),
      makeSymbol("useUserFiltersLegacy", "src/other.ts"),
    ]);

    const matches = toolkit.findReusableSymbols!(toFilePath("src/feature.ts"), "user filters", 5);

    expect(matches[0]?.filePath).toBe(toFilePath("src/shared/hooks.ts"));
    expect(matches[0]?.relation).toBe("imports");
  });

  test("returns empty reusable symbol matches when query is blank", () => {
    const toolkit = buildReviewToolkit(makeGraph([], []), [], [
      makeSymbol("useUserFilters", "src/shared/hooks.ts"),
    ]);

    const matches = toolkit.findReusableSymbols!(toFilePath("src/feature.ts"), "   ", 5);

    expect(matches).toEqual([]);
  });

});
