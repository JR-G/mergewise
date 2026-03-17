import { describe, test, expect } from "bun:test";
import { formatJsonReport, formatMarkdownReport } from "./report";
import type { DebtProfile, DebtGraph, HotspotEntry, DebtFinding } from "./graph-types";

interface JsonReportShape {
  hotspots: unknown[];
  findings: unknown[];
  summary: { hotspotCount: number; totalFindings: number };
}

function makeGraph(nodeCount: number): DebtGraph {
  const nodes = new Map<string, DebtGraph["nodes"] extends Map<string, infer V> ? V : never>();
  for (let index = 0; index < nodeCount; index++) {
    const filePath = `src/file-${index}.ts`;
    nodes.set(filePath, {
      id: filePath,
      kind: "file",
      filePath,
      lineCount: 100,
      centrality: 0.1,
      signals: {
        functionCount: 2, hookCount: 0, maxNestingDepth: 1,
        classCount: 0, maxParameterCount: 1, typeAssertionCount: 0,
        maxFunctionLineCount: 20, componentLineCount: 0, importCount: 1,
      },
    });
  }
  return { nodes, edges: [] };
}

function makeHotspot(filePath: string, score: number): HotspotEntry {
  return { nodeId: filePath, filePath, score, centrality: score, signalDensity: 1, lineCount: 100 };
}

function makeFinding(nodeId: string, index: number): DebtFinding {
  return {
    nodeId,
    patternId: "test-pattern",
    category: "complexity",
    title: `Finding ${index}`,
    recommendation: "Fix it",
    confidence: 0.9,
    lineRange: [index * 10, index * 10 + 5] as [number, number],
  };
}

function makeProfile(overrides: Partial<DebtProfile> = {}): DebtProfile {
  return {
    repoPath: "/test/repo",
    scannedAt: "2026-03-01T12:00:00.000Z",
    graph: makeGraph(2),
    findings: [],
    hotspots: [makeHotspot("src/file-0.ts", 3.5)],
    ...overrides,
  };
}

describe("formatJsonReport", () => {
  test("caps hotspots at 50", () => {
    const hotspots = Array.from({ length: 60 }, (_, index) =>
      makeHotspot(`src/file-${index}.ts`, 60 - index),
    );
    const profile = makeProfile({ hotspots, graph: makeGraph(60) });
    const result = JSON.parse(formatJsonReport(profile)) as JsonReportShape;

    expect(result.hotspots.length).toBe(50);
    expect(result.summary.hotspotCount).toBe(60);
  });

  test("caps findings per file at 20", () => {
    const findings = Array.from({ length: 25 }, (_, index) =>
      makeFinding("src/file-0.ts", index),
    );
    const profile = makeProfile({ findings });
    const result = JSON.parse(formatJsonReport(profile)) as JsonReportShape;

    expect(result.findings.length).toBe(20);
    expect(result.summary.totalFindings).toBe(25);
  });

  test("caps findings independently per file", () => {
    const findingsA = Array.from({ length: 25 }, (_, index) =>
      makeFinding("src/file-a.ts", index),
    );
    const findingsB = Array.from({ length: 25 }, (_, index) =>
      makeFinding("src/file-b.ts", index),
    );
    const profile = makeProfile({ findings: [...findingsA, ...findingsB] });
    const result = JSON.parse(formatJsonReport(profile)) as JsonReportShape;

    expect(result.findings.length).toBe(40);
  });

  test("returns empty arrays for empty profile", () => {
    const profile = makeProfile({ hotspots: [], findings: [] });
    const result = JSON.parse(formatJsonReport(profile)) as JsonReportShape;

    expect(result.hotspots).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.summary.hotspotCount).toBe(0);
    expect(result.summary.totalFindings).toBe(0);
  });
});

describe("formatMarkdownReport", () => {
  test("includes hotspot table rows", () => {
    const profile = makeProfile();
    const markdown = formatMarkdownReport(profile);

    expect(markdown).toContain("src/file-0.ts");
    expect(markdown).toContain("# Tech Debt Report");
  });

  test("caps hotspots at 50 with omission note", () => {
    const hotspots = Array.from({ length: 60 }, (_, index) =>
      makeHotspot(`src/file-${index}.ts`, 60 - index),
    );
    const profile = makeProfile({ hotspots, graph: makeGraph(60) });
    const markdown = formatMarkdownReport(profile);

    expect(markdown).toContain("10 more omitted");
  });

  test("includes findings section when findings exist", () => {
    const findings = [makeFinding("src/file-0.ts", 1)];
    const profile = makeProfile({ findings });
    const markdown = formatMarkdownReport(profile);

    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("Fix it");
  });

  test("omits findings section when no findings", () => {
    const profile = makeProfile({ findings: [] });
    const markdown = formatMarkdownReport(profile);

    expect(markdown).not.toContain("## Findings");
  });
});
