import { describe, expect, test } from "bun:test";
import { rankHotspots, computeSignalDensity } from "./hotspot-ranker.ts";
import type { DebtGraph, DebtNode } from "./graph-types.ts";
import type { StructuralSignals } from "@mergewise/llm-reviewer";

function makeSignals(overrides: Partial<StructuralSignals> = {}): StructuralSignals {
  return {
    componentLineCount: 0,
    hookCount: 0,
    importCount: 0,
    maxNestingDepth: 0,
    functionCount: 0,
    maxFunctionLineCount: 0,
    maxParameterCount: 0,
    classCount: 0,
    typeAssertionCount: 0,
    ...overrides,
  };
}

function makeNode(id: string, centrality: number, signals: StructuralSignals, lineCount = 100): DebtNode {
  return {
    id,
    kind: "file",
    filePath: id,
    signals,
    lineCount,
    centrality,
  };
}

describe("hotspot-ranker", () => {
  test("ranks files with higher centrality × signal density first", () => {
    const nodes = new Map<string, DebtNode>();
    nodes.set(
      "complex.ts",
      makeNode("complex.ts", 0.2, makeSignals({ functionCount: 10, maxNestingDepth: 4 }), 300),
    );
    nodes.set(
      "simple.ts",
      makeNode("simple.ts", 0.1, makeSignals({ functionCount: 2, maxNestingDepth: 1 }), 50),
    );
    nodes.set(
      "central.ts",
      makeNode("central.ts", 0.9, makeSignals({ functionCount: 10, maxNestingDepth: 5 }), 400),
    );

    const graph: DebtGraph = { nodes, edges: [] };
    const hotspots = rankHotspots(graph, 3);

    expect(hotspots[0]!.filePath).toBe("central.ts");
    expect(hotspots[0]!.score).toBeGreaterThan(hotspots[1]!.score);
  });

  test("respects topCount limit", () => {
    const nodes = new Map<string, DebtNode>();
    for (let index = 0; index < 10; index++) {
      const id = `file${index}.ts`;
      nodes.set(id, makeNode(id, 0.1 * (index + 1), makeSignals({ functionCount: 5 })));
    }

    const graph: DebtGraph = { nodes, edges: [] };
    const hotspots = rankHotspots(graph, 3);

    expect(hotspots).toHaveLength(3);
    expect(hotspots[0]!.score).toBeGreaterThanOrEqual(hotspots[1]!.score);
    expect(hotspots[1]!.score).toBeGreaterThanOrEqual(hotspots[2]!.score);
  });

  test("signal density is zero for empty file", () => {
    const density = computeSignalDensity(makeSignals(), 0);
    expect(density).toBe(0);
  });

  test("signal density increases with complexity indicators", () => {
    const simpleDensity = computeSignalDensity(
      makeSignals({ functionCount: 1, maxNestingDepth: 1 }),
      50,
    );
    const complexDensity = computeSignalDensity(
      makeSignals({ functionCount: 15, maxNestingDepth: 5, hookCount: 4, classCount: 2 }),
      300,
    );

    expect(complexDensity).toBeGreaterThan(simpleDensity);
  });
});
