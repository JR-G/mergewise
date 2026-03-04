import { describe, test, expect } from "bun:test";
import { buildPrGraphContext, formatGraphContextPrompt } from "./graph-context.ts";
import type { DebtGraph, DebtNode, DebtEdge, HotspotEntry } from "./graph-types.ts";

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

function makeGraph(
  nodes: DebtNode[],
  edges: DebtEdge[],
): DebtGraph {
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

describe("buildPrGraphContext", () => {
  test("returns context for changed files with reverse dependencies", () => {
    const graph = makeGraph(
      [
        makeNode("src/auth.ts", 0.82),
        makeNode("src/login.ts", 0.3),
        makeNode("src/signup.ts", 0.25),
        makeNode("src/utils.ts", 0.1),
      ],
      [
        { source: "src/login.ts", target: "src/auth.ts", kind: "imports" },
        { source: "src/signup.ts", target: "src/auth.ts", kind: "imports" },
        { source: "src/auth.ts", target: "src/utils.ts", kind: "imports" },
      ],
    );

    const hotspots = [makeHotspot("src/auth.ts", 0.82)];
    const context = buildPrGraphContext(["src/auth.ts", "src/utils.ts"], graph, hotspots);

    expect(context.files.some((file) => file.filePath === "src/auth.ts")).toBe(true);
    expect(context.files.some((file) => file.filePath === "src/utils.ts")).toBe(true);

    const authFile = context.files.find((file) => file.filePath === "src/auth.ts");
    expect(authFile?.importedBy).toContain("src/login.ts");
    expect(authFile?.importedBy).toContain("src/signup.ts");
    expect(authFile?.isHotspot).toBe(true);

    const utilsFile = context.files.find((file) => file.filePath === "src/utils.ts");
    expect(utilsFile?.importedBy).toContain("src/auth.ts");
    expect(utilsFile?.isHotspot).toBe(false);
  });

  test("returns forward imports for changed files", () => {
    const graph = makeGraph(
      [
        makeNode("src/main.ts", 0.5),
        makeNode("src/db.ts", 0.4),
        makeNode("src/config.ts", 0.2),
      ],
      [
        { source: "src/main.ts", target: "src/db.ts", kind: "imports" },
        { source: "src/main.ts", target: "src/config.ts", kind: "imports" },
      ],
    );

    const context = buildPrGraphContext(["src/main.ts"], graph, []);
    const mainFile = context.files.find((file) => file.filePath === "src/main.ts");

    expect(mainFile?.imports).toContain("src/db.ts");
    expect(mainFile?.imports).toContain("src/config.ts");
  });

  test("handles changed files not present in the graph", () => {
    const graph = makeGraph([], []);
    const context = buildPrGraphContext(["src/new-file.ts"], graph, []);

    expect(context.files).toHaveLength(1);
    expect(context.files[0]?.centralityScore).toBe(0);
    expect(context.files[0]?.importedBy).toEqual([]);
  });

  test("sorts files by centrality descending", () => {
    const graph = makeGraph(
      [
        makeNode("src/low.ts", 0.1),
        makeNode("src/high.ts", 0.9),
        makeNode("src/mid.ts", 0.5),
      ],
      [],
    );

    const context = buildPrGraphContext(["src/low.ts", "src/high.ts", "src/mid.ts"], graph, []);
    const paths = context.files.map((file) => file.filePath);

    expect(paths).toEqual(["src/high.ts", "src/mid.ts", "src/low.ts"]);
  });

  test("impact summary reflects dependency and hotspot counts", () => {
    const graph = makeGraph(
      [
        makeNode("src/core.ts", 0.8),
        makeNode("src/a.ts", 0.3),
        makeNode("src/b.ts", 0.2),
      ],
      [
        { source: "src/a.ts", target: "src/core.ts", kind: "imports" },
        { source: "src/b.ts", target: "src/core.ts", kind: "imports" },
      ],
    );

    const hotspots = [makeHotspot("src/core.ts", 0.8)];
    const context = buildPrGraphContext(["src/core.ts"], graph, hotspots);

    expect(context.impactSummary).toContain("1 changed file");
    expect(context.impactSummary).toContain("2 other files");
    expect(context.impactSummary).toContain("1 is a known debt hotspot");
  });

  test("only counts import edges for reverse dependencies", () => {
    const graph = makeGraph(
      [
        makeNode("src/base.ts", 0.5),
        makeNode("src/child.ts", 0.3),
      ],
      [
        { source: "src/child.ts", target: "src/base.ts", kind: "extends" },
      ],
    );

    const context = buildPrGraphContext(["src/base.ts"], graph, []);
    const baseFile = context.files.find((file) => file.filePath === "src/base.ts");

    expect(baseFile?.importedBy).toEqual([]);
  });
});

describe("formatGraphContextPrompt", () => {
  test("returns empty string when no files", () => {
    const result = formatGraphContextPrompt({ files: [], impactSummary: "" });
    expect(result).toBe("");
  });

  test("includes impact summary and file details", () => {
    const context = buildPrGraphContext(
      ["src/auth.ts"],
      makeGraph(
        [makeNode("src/auth.ts", 0.82), makeNode("src/login.ts", 0.3)],
        [{ source: "src/login.ts", target: "src/auth.ts", kind: "imports" }],
      ),
      [makeHotspot("src/auth.ts", 0.82)],
    );

    const prompt = formatGraphContextPrompt(context);

    expect(prompt).toContain("Codebase impact context");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("centrality: 0.82");
    expect(prompt).toContain("HIGH IMPACT");
    expect(prompt).toContain("blast radius");
  });

  test("labels low centrality files as low impact", () => {
    const context = buildPrGraphContext(
      ["src/utils.ts"],
      makeGraph([makeNode("src/utils.ts", 0.1)], []),
      [],
    );

    const prompt = formatGraphContextPrompt(context);

    expect(prompt).toContain("low impact");
    expect(prompt).not.toContain("HIGH IMPACT");
    expect(prompt).not.toContain("blast radius");
  });
});
