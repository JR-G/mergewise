import { describe, expect, test } from "bun:test";
import { compareScans } from "./compare.ts";
import type { DebtProfile, DebtGraph, DebtFinding, HotspotEntry } from "./graph-types.ts";

const EMPTY_GRAPH: DebtGraph = { nodes: new Map(), edges: [] };

function makeProfile(
  findings: DebtFinding[],
  hotspots: HotspotEntry[],
  overrides: Partial<DebtProfile> = {},
): DebtProfile {
  return {
    repoPath: "/test/repo",
    scannedAt: "2026-03-01T12:00:00.000Z",
    graph: EMPTY_GRAPH,
    findings,
    hotspots,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<DebtFinding> = {}): DebtFinding {
  return {
    nodeId: "src/index.ts",
    patternId: "god-function",
    category: "complexity",
    title: "Function too large",
    recommendation: "Split it",
    confidence: 0.85,
    lineRange: [10, 50],
    ...overrides,
  };
}

function makeHotspot(filePath: string, score: number): HotspotEntry {
  return {
    nodeId: filePath,
    filePath,
    score,
    centrality: 0.5,
    signalDensity: score / 0.5,
    lineCount: 100,
  };
}

describe("compareScans", () => {
  test("detects new findings", () => {
    const previous = makeProfile([makeFinding()], []);
    const current = makeProfile([
      makeFinding(),
      makeFinding({ patternId: "deep-nesting", lineRange: [60, 80] }),
    ], []);

    const result = compareScans(previous, current);
    expect(result.newFindings.some((finding) => finding.patternId === "deep-nesting")).toBe(true);
    expect(result.resolvedFindings).toEqual([]);
  });

  test("detects resolved findings", () => {
    const previous = makeProfile([
      makeFinding(),
      makeFinding({ patternId: "deep-nesting", lineRange: [60, 80] }),
    ], []);
    const current = makeProfile([makeFinding()], []);

    const result = compareScans(previous, current);
    expect(result.resolvedFindings.some((finding) => finding.patternId === "deep-nesting")).toBe(true);
    expect(result.newFindings).toEqual([]);
  });

  test("direction is improving when more resolved than new", () => {
    const previous = makeProfile([
      makeFinding({ patternId: "a", lineRange: [1, 10] }),
      makeFinding({ patternId: "b", lineRange: [20, 30] }),
    ], []);
    const current = makeProfile([], []);

    const result = compareScans(previous, current);
    expect(result.direction).toBe("improving");
  });

  test("direction is degrading when more new than resolved", () => {
    const previous = makeProfile([], []);
    const current = makeProfile([
      makeFinding({ patternId: "a", lineRange: [1, 10] }),
      makeFinding({ patternId: "b", lineRange: [20, 30] }),
    ], []);

    const result = compareScans(previous, current);
    expect(result.direction).toBe("degrading");
  });

  test("direction is stable when equal new and resolved", () => {
    const previous = makeProfile([
      makeFinding({ patternId: "a", lineRange: [1, 10] }),
    ], []);
    const current = makeProfile([
      makeFinding({ patternId: "b", lineRange: [20, 30] }),
    ], []);

    const result = compareScans(previous, current);
    expect(result.direction).toBe("stable");
  });

  test("tracks hotspot rank changes", () => {
    const previous = makeProfile([], [
      makeHotspot("src/big.ts", 10),
      makeHotspot("src/medium.ts", 5),
    ]);
    const current = makeProfile([], [
      makeHotspot("src/medium.ts", 8),
      makeHotspot("src/big.ts", 7),
    ]);

    const result = compareScans(previous, current);
    const bigChange = result.hotspotChanges.find((change) => change.filePath === "src/big.ts");
    expect(bigChange).toBeDefined();
    expect(bigChange!.previousRank).toBe(1);
    expect(bigChange!.currentRank).toBe(2);
    expect(bigChange!.scoreDelta).toBeLessThan(0);
  });

  test("handles new hotspots appearing", () => {
    const previous = makeProfile([], [makeHotspot("src/old.ts", 5)]);
    const current = makeProfile([], [
      makeHotspot("src/old.ts", 5),
      makeHotspot("src/new.ts", 3),
    ]);

    const result = compareScans(previous, current);
    const newEntry = result.hotspotChanges.find((change) => change.filePath === "src/new.ts");
    expect(newEntry).toBeDefined();
    expect(newEntry!.previousRank).toBeNull();
    expect(newEntry!.currentRank).toBe(2);
  });

  test("handles hotspots disappearing", () => {
    const previous = makeProfile([], [
      makeHotspot("src/a.ts", 5),
      makeHotspot("src/gone.ts", 3),
    ]);
    const current = makeProfile([], [makeHotspot("src/a.ts", 5)]);

    const result = compareScans(previous, current);
    const gone = result.hotspotChanges.find((change) => change.filePath === "src/gone.ts");
    expect(gone).toBeDefined();
    expect(gone!.currentRank).toBeNull();
    expect(gone!.scoreDelta).toBeLessThan(0);
  });
});
