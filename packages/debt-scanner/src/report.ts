import type { DebtFinding, DebtProfile } from "./graph-types.ts";
import type { HotspotChange, ScanComparison } from "./compare.ts";

const MAX_HOTSPOTS = 50;
const MAX_FINDINGS_PER_FILE = 20;
const MAX_COMPARISON_ITEMS = 30;

/**
 * Formats a debt profile as a JSON string.
 */
export function formatJsonReport(profile: DebtProfile): string {
  const serialisable = {
    repoPath: profile.repoPath,
    scannedAt: profile.scannedAt,
    summary: {
      totalFiles: profile.totalFiles ?? profile.graph.nodes.size,
      totalEdges: profile.totalEdges ?? profile.graph.edges.length,
      totalFindings: profile.findings.length,
      hotspotCount: profile.hotspots.length,
    },
    hotspots: profile.hotspots,
    findings: profile.findings,
  };

  return JSON.stringify(serialisable, null, 2);
}

/**
 * Formats a debt profile as a markdown report.
 */
export function formatMarkdownReport(profile: DebtProfile): string {
  const parts: string[] = [];

  parts.push("# Tech Debt Report");
  parts.push("");
  parts.push(`**Repository:** ${profile.repoPath}`);
  parts.push(`**Scanned at:** ${profile.scannedAt}`);
  parts.push(`**Files analysed:** ${profile.totalFiles ?? profile.graph.nodes.size}`);
  parts.push(`**Import edges:** ${profile.totalEdges ?? profile.graph.edges.length}`);
  parts.push(`**Findings:** ${profile.findings.length}`);
  parts.push("");

  parts.push("## Hotspots");
  parts.push("");
  parts.push("| Rank | File | Lines | Centrality | Signal Density | Score |");
  parts.push("| ---: | ---- | ----: | ---------: | -------------: | ----: |");

  const hotspotLimit = Math.min(profile.hotspots.length, MAX_HOTSPOTS);
  for (let index = 0; index < hotspotLimit; index++) {
    const hotspot = profile.hotspots[index];
    if (!hotspot) continue;
    parts.push(
      `| ${index + 1} | ${hotspot.filePath} | ${hotspot.lineCount} | ${hotspot.centrality.toFixed(4)} | ${hotspot.signalDensity.toFixed(2)} | ${hotspot.score.toFixed(4)} |`,
    );
  }
  const omittedHotspots = profile.hotspots.length - hotspotLimit;
  if (omittedHotspots > 0) {
    parts.push(`| | *(${omittedHotspots} more omitted)* | | | | |`);
  }

  if (profile.findings.length > 0) {
    parts.push("");
    parts.push("## Findings");
    parts.push("");

    const groupedByFile = new Map<string, typeof profile.findings>();
    for (const finding of profile.findings) {
      const existing = groupedByFile.get(finding.nodeId) ?? [];
      groupedByFile.set(finding.nodeId, [...existing, finding]);
    }

    for (const [nodeId, fileFindings] of groupedByFile) {
      parts.push(`### ${nodeId}`);
      parts.push("");

      const cappedFindings = fileFindings.slice(0, MAX_FINDINGS_PER_FILE);
      for (const finding of cappedFindings) {
        parts.push(`- **[${finding.category}]** L${finding.lineRange[0]}–${finding.lineRange[1]} (${(finding.confidence * 100).toFixed(0)}%)`);
        parts.push(`  ${finding.recommendation}`);
        if (finding.patternId !== "custom") {
          parts.push(`  Pattern: \`${finding.patternId}\``);
        }
        parts.push("");
      }

      const omittedFindings = fileFindings.length - cappedFindings.length;
      if (omittedFindings > 0) {
        parts.push(`*(${omittedFindings} more findings omitted)*`);
        parts.push("");
      }
    }
  }

  return parts.join("\n");
}

const DIRECTION_LABEL: Record<ScanComparison["direction"], string> = {
  improving: "Improving ↑",
  stable: "Stable →",
  degrading: "Degrading ↓",
};

/**
 * Formats a scan comparison as a markdown section.
 */
export function formatComparisonMarkdown(comparison: ScanComparison): string {
  const parts: string[] = [];
  const previousDate = comparison.previous.scannedAt.split("T")[0] ?? comparison.previous.scannedAt;

  parts.push(`## Comparison with previous scan (${previousDate})`);
  parts.push("");
  parts.push(`**Direction:** ${DIRECTION_LABEL[comparison.direction]}`);
  parts.push("");

  const fileDelta = comparison.current.totalFiles - comparison.previous.totalFiles;
  const findingDelta = comparison.current.totalFindings - comparison.previous.totalFindings;
  const hotspotDelta = comparison.current.hotspotCount - comparison.previous.hotspotCount;

  parts.push("| Metric | Previous | Current | Delta |");
  parts.push("| ------ | -------: | ------: | ----: |");
  parts.push(`| Files | ${comparison.previous.totalFiles} | ${comparison.current.totalFiles} | ${formatDelta(fileDelta)} |`);
  parts.push(`| Findings | ${comparison.previous.totalFindings} | ${comparison.current.totalFindings} | ${formatDelta(findingDelta)} |`);
  parts.push(`| Hotspots | ${comparison.previous.hotspotCount} | ${comparison.current.hotspotCount} | ${formatDelta(hotspotDelta)} |`);
  parts.push("");

  appendFindingsSection(parts, "New findings", comparison.newFindings);
  appendFindingsSection(parts, "Resolved findings", comparison.resolvedFindings);
  appendHotspotChangesSection(parts, comparison.hotspotChanges);

  return parts.join("\n");
}

function appendFindingsSection(
  parts: string[],
  heading: string,
  findings: readonly DebtFinding[],
): void {
  if (findings.length === 0) return;

  parts.push(`### ${heading} (${findings.length})`);
  parts.push("");

  const capped = findings.slice(0, MAX_COMPARISON_ITEMS);
  for (const finding of capped) {
    parts.push(`- **[${finding.category}]** ${finding.nodeId} L${finding.lineRange[0]}–${finding.lineRange[1]}: ${finding.title}`);
  }

  const omitted = findings.length - capped.length;
  if (omitted > 0) parts.push(`*(${omitted} more omitted)*`);
  parts.push("");
}

function appendHotspotChangesSection(
  parts: string[],
  changes: readonly HotspotChange[],
): void {
  if (changes.length === 0) return;

  parts.push("### Hotspot movement");
  parts.push("");
  parts.push("| File | Previous rank | Current rank | Score delta |");
  parts.push("| ---- | -----------: | ----------: | ----------: |");

  const capped = changes.slice(0, MAX_COMPARISON_ITEMS);
  for (const change of capped) {
    parts.push(
      `| ${change.filePath} | ${change.previousRank ?? "—"} | ${change.currentRank ?? "—"} | ${change.scoreDelta >= 0 ? "+" : ""}${change.scoreDelta.toFixed(4)} |`,
    );
  }

  const omitted = changes.length - capped.length;
  if (omitted > 0) parts.push(`| | *(${omitted} more omitted)* | | |`);
  parts.push("");
}

/**
 * Formats a scan comparison as a JSON string.
 */
export function formatComparisonJson(comparison: ScanComparison): string {
  return JSON.stringify(comparison, null, 2);
}

function formatDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return String(value);
}
