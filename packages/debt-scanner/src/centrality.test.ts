import { describe, expect, test } from "bun:test";
import { computeCentrality } from "./centrality";
import type { DebtGraph, DebtNode, DebtEdge } from "./graph-types";
import type { StructuralSignals } from "@mergewise/llm-reviewer";

const EMPTY_SIGNALS: StructuralSignals = {
  componentLineCount: 0,
  hookCount: 0,
  importCount: 0,
  maxNestingDepth: 0,
  functionCount: 0,
  maxFunctionLineCount: 0,
  maxParameterCount: 0,
  classCount: 0,
  typeAssertionCount: 0,
};

function makeNode(id: string): DebtNode {
  return {
    id,
    kind: "file",
    filePath: id,
    signals: EMPTY_SIGNALS,
    lineCount: 100,
    centrality: 0,
  };
}

describe("centrality", () => {
  test("hub file imported by many files gets highest centrality", () => {
    const nodes = new Map<string, DebtNode>();
    nodes.set("hub.ts", makeNode("hub.ts"));
    nodes.set("a.ts", makeNode("a.ts"));
    nodes.set("b.ts", makeNode("b.ts"));
    nodes.set("c.ts", makeNode("c.ts"));
    nodes.set("leaf.ts", makeNode("leaf.ts"));

    const edges: DebtEdge[] = [
      { source: "a.ts", target: "hub.ts", kind: "imports" },
      { source: "b.ts", target: "hub.ts", kind: "imports" },
      { source: "c.ts", target: "hub.ts", kind: "imports" },
      { source: "hub.ts", target: "leaf.ts", kind: "imports" },
    ];

    const graph: DebtGraph = { nodes, edges };
    computeCentrality(graph);

    const hubScore = nodes.get("hub.ts")!.centrality;
    const leafScore = nodes.get("leaf.ts")!.centrality;
    const consumerScore = nodes.get("a.ts")!.centrality;

    expect(hubScore).toBeGreaterThan(consumerScore);
    expect(leafScore).toBeGreaterThan(consumerScore);
  });

  test("isolated nodes get uniform centrality", () => {
    const nodes = new Map<string, DebtNode>();
    nodes.set("a.ts", makeNode("a.ts"));
    nodes.set("b.ts", makeNode("b.ts"));

    const graph: DebtGraph = { nodes, edges: [] };
    computeCentrality(graph);

    const scoreA = nodes.get("a.ts")!.centrality;
    const scoreB = nodes.get("b.ts")!.centrality;

    expect(scoreA).toBeCloseTo(scoreB, 6);
    expect(scoreA).toBeGreaterThan(0);
  });

  test("handles empty graph without errors", () => {
    const graph: DebtGraph = { nodes: new Map(), edges: [] };
    computeCentrality(graph);
  });

  test("chain topology gives highest score to terminal node", () => {
    const nodes = new Map<string, DebtNode>();
    nodes.set("a.ts", makeNode("a.ts"));
    nodes.set("b.ts", makeNode("b.ts"));
    nodes.set("c.ts", makeNode("c.ts"));

    const edges: DebtEdge[] = [
      { source: "a.ts", target: "b.ts", kind: "imports" },
      { source: "b.ts", target: "c.ts", kind: "imports" },
    ];

    const graph: DebtGraph = { nodes, edges };
    computeCentrality(graph);

    const scoreA = nodes.get("a.ts")!.centrality;
    const scoreB = nodes.get("b.ts")!.centrality;
    const scoreC = nodes.get("c.ts")!.centrality;

    expect(scoreC).toBeGreaterThan(scoreB);
    expect(scoreB).toBeGreaterThan(scoreA);
  });
});
