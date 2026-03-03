import type { DebtProfile, DebtFinding, HotspotEntry, ScanSummary } from "./graph-types.ts";

export interface HotspotChange {
  readonly filePath: string;
  readonly previousRank: number | null;
  readonly currentRank: number | null;
  readonly scoreDelta: number;
}

export type TrendDirection = "improving" | "stable" | "degrading";

export interface ScanComparison {
  readonly previous: ScanSummary;
  readonly current: ScanSummary;
  readonly newFindings: DebtFinding[];
  readonly resolvedFindings: DebtFinding[];
  readonly hotspotChanges: HotspotChange[];
  readonly direction: TrendDirection;
}

function findingKey(finding: DebtFinding): string {
  return `${finding.nodeId}::${finding.patternId}::${finding.lineRange[0]}`;
}

function profileToSummary(profile: DebtProfile, id: string): ScanSummary {
  return {
    id,
    repoPath: profile.repoPath,
    scannedAt: profile.scannedAt,
    totalFiles: profile.graph.nodes.size,
    totalEdges: profile.graph.edges.length,
    totalFindings: profile.findings.length,
    hotspotCount: profile.hotspots.length,
  };
}

/**
 * Compares two debt scans and produces a structured diff.
 *
 * Findings are matched by `(nodeId, patternId, lineStart)`.
 * Hotspots are matched by `filePath`.
 */
export function compareScans(
  previous: DebtProfile,
  current: DebtProfile,
  previousId = "previous",
  currentId = "current",
): ScanComparison {
  const previousKeys = new Set(previous.findings.map(findingKey));
  const currentKeys = new Set(current.findings.map(findingKey));

  const newFindings = current.findings.filter(
    (finding) => !previousKeys.has(findingKey(finding)),
  );
  const resolvedFindings = previous.findings.filter(
    (finding) => !currentKeys.has(findingKey(finding)),
  );

  const previousRanks = buildRankMap(previous.hotspots);
  const currentRanks = buildRankMap(current.hotspots);

  const allFiles = new Set([...previousRanks.keys(), ...currentRanks.keys()]);
  const hotspotChanges: HotspotChange[] = [];

  for (const filePath of allFiles) {
    const prev = previousRanks.get(filePath);
    const curr = currentRanks.get(filePath);
    const scoreDelta = (curr?.score ?? 0) - (prev?.score ?? 0);

    if (prev?.rank !== curr?.rank || Math.abs(scoreDelta) > 0.0001) {
      hotspotChanges.push({
        filePath,
        previousRank: prev?.rank ?? null,
        currentRank: curr?.rank ?? null,
        scoreDelta,
      });
    }
  }

  hotspotChanges.sort((left, right) => Math.abs(right.scoreDelta) - Math.abs(left.scoreDelta));

  const direction = determineDirection(resolvedFindings.length, newFindings.length);

  return {
    previous: profileToSummary(previous, previousId),
    current: profileToSummary(current, currentId),
    newFindings: [...newFindings],
    resolvedFindings: [...resolvedFindings],
    hotspotChanges,
    direction,
  };
}

function buildRankMap(
  hotspots: readonly HotspotEntry[],
): Map<string, { rank: number; score: number }> {
  const ranks = new Map<string, { rank: number; score: number }>();
  for (const [index, hotspot] of hotspots.entries()) {
    ranks.set(hotspot.filePath, { rank: index + 1, score: hotspot.score });
  }
  return ranks;
}

function determineDirection(resolvedCount: number, newCount: number): TrendDirection {
  if (resolvedCount > newCount) return "improving";
  if (resolvedCount < newCount) return "degrading";
  return "stable";
}
