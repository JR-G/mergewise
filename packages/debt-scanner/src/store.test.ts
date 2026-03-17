import { describe, expect, test, afterEach } from "bun:test";
import { openStore } from "./store";
import type { DebtProfile, DebtGraph, DebtFinding, HotspotEntry } from "./graph-types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

function tempDbPath(): string {
  return join(tmpdir(), `debt-test-${crypto.randomUUID()}.db`);
}

function makeProfile(overrides: Partial<DebtProfile> = {}): DebtProfile {
  const graph: DebtGraph = {
    nodes: new Map([
      ["src/index.ts", {
        id: "src/index.ts",
        kind: "file",
        filePath: "src/index.ts",
        signals: {
          componentLineCount: 0, hookCount: 0, importCount: 3,
          maxNestingDepth: 2, functionCount: 5, maxFunctionLineCount: 40,
          maxParameterCount: 3, classCount: 0, typeAssertionCount: 0,
        },
        lineCount: 120,
        centrality: 0.5,
      }],
      ["src/utils.ts", {
        id: "src/utils.ts",
        kind: "file",
        filePath: "src/utils.ts",
        signals: {
          componentLineCount: 0, hookCount: 0, importCount: 0,
          maxNestingDepth: 1, functionCount: 2, maxFunctionLineCount: 20,
          maxParameterCount: 1, classCount: 0, typeAssertionCount: 0,
        },
        lineCount: 40,
        centrality: 0.1,
      }],
    ]),
    edges: [{ source: "src/index.ts", target: "src/utils.ts", kind: "imports" }],
  };

  const hotspots: HotspotEntry[] = [{
    nodeId: "src/index.ts",
    filePath: "src/index.ts",
    score: 3.5,
    centrality: 0.5,
    signalDensity: 7.0,
    lineCount: 120,
  }];

  const findings: DebtFinding[] = [{
    nodeId: "src/index.ts",
    patternId: "god-function",
    category: "complexity",
    title: "Function too large",
    recommendation: "Split into smaller functions",
    confidence: 0.85,
    lineRange: [10, 50],
  }];

  return {
    repoPath: "/test/repo",
    scannedAt: "2026-03-01T12:00:00.000Z",
    graph,
    findings,
    hotspots,
    ...overrides,
  };
}

const dbPaths: string[] = [];

afterEach(() => {
  for (const dbPath of dbPaths) {
    try { unlinkSync(dbPath); } catch { /* noop */ }
    try { unlinkSync(`${dbPath}-wal`); } catch { /* noop */ }
    try { unlinkSync(`${dbPath}-shm`); } catch { /* noop */ }
  }
  dbPaths.length = 0;
});

function trackDb(): string {
  const path = tempDbPath();
  dbPaths.push(path);
  return path;
}

describe("store", () => {
  test("creates schema on fresh database", () => {
    const store = openStore(trackDb());
    const scans = store.listScans();
    expect(scans).toEqual([]);
    store.close();
  });

  test("saves and loads a scan round-trip", () => {
    const dbPath = trackDb();
    const store = openStore(dbPath);
    const profile = makeProfile();

    const scanId = store.saveScan(profile);
    expect(scanId).toBeTruthy();

    const loaded = store.loadScan(scanId);
    expect(loaded).not.toBeNull();
    expect(loaded!.repoPath).toBe(profile.repoPath);
    expect(loaded!.scannedAt).toBe(profile.scannedAt);
    expect(loaded!.hotspots).toEqual(profile.hotspots);
    expect(loaded!.findings).toEqual(profile.findings);
    expect(loaded!.graph.nodes.size).toBe(profile.graph.nodes.size);
    expect(loaded!.graph.edges).toEqual(profile.graph.edges);

    const loadedNode = loaded!.graph.nodes.get("src/index.ts");
    const originalNode = profile.graph.nodes.get("src/index.ts");
    expect(loadedNode).toBeDefined();
    expect(loadedNode!.kind).toBe(originalNode!.kind);
    expect(loadedNode!.filePath).toBe(originalNode!.filePath);
    expect(loadedNode!.signals).toEqual(originalNode!.signals);
    expect(loadedNode!.lineCount).toBe(originalNode!.lineCount);
    expect(loadedNode!.centrality).toBe(originalNode!.centrality);

    store.close();
  });

  test("listScans returns entries ordered by most recent first", () => {
    const store = openStore(trackDb());

    store.saveScan(makeProfile({ scannedAt: "2026-03-01T10:00:00.000Z" }));
    store.saveScan(makeProfile({ scannedAt: "2026-03-02T10:00:00.000Z" }));
    store.saveScan(makeProfile({ scannedAt: "2026-03-01T08:00:00.000Z" }));

    const scans = store.listScans();
    expect(scans[0]!.scannedAt).toBe("2026-03-02T10:00:00.000Z");
    expect(scans[2]!.scannedAt).toBe("2026-03-01T08:00:00.000Z");

    store.close();
  });

  test("listScans filters by repoPath", () => {
    const store = openStore(trackDb());

    store.saveScan(makeProfile({ repoPath: "/repo/a" }));
    store.saveScan(makeProfile({ repoPath: "/repo/b" }));
    store.saveScan(makeProfile({ repoPath: "/repo/a" }));

    const scansA = store.listScans("/repo/a");
    const scansB = store.listScans("/repo/b");

    expect(scansA.every((scan) => scan.repoPath === "/repo/a")).toBe(true);
    expect(scansB.every((scan) => scan.repoPath === "/repo/b")).toBe(true);

    store.close();
  });

  test("latestScan returns most recent scan for repo", () => {
    const store = openStore(trackDb());

    store.saveScan(makeProfile({ scannedAt: "2026-03-01T10:00:00.000Z" }));
    store.saveScan(makeProfile({ scannedAt: "2026-03-03T10:00:00.000Z" }));

    const latest = store.latestScan("/test/repo");
    expect(latest).not.toBeNull();
    expect(latest!.scannedAt).toBe("2026-03-03T10:00:00.000Z");

    store.close();
  });

  test("latestScan returns null for unknown repo", () => {
    const store = openStore(trackDb());
    const result = store.latestScan("/nonexistent");
    expect(result).toBeNull();
    store.close();
  });

  test("loadScan returns null for unknown scan ID", () => {
    const store = openStore(trackDb());
    const result = store.loadScan("nonexistent-id");
    expect(result).toBeNull();
    store.close();
  });

  test("persists across store reopens", () => {
    const dbPath = trackDb();

    const storeA = openStore(dbPath);
    const scanId = storeA.saveScan(makeProfile());
    storeA.close();

    const storeB = openStore(dbPath);
    const loaded = storeB.loadScan(scanId);
    expect(loaded).not.toBeNull();
    expect(loaded!.repoPath).toBe("/test/repo");
    storeB.close();
  });
});
