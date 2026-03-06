import type { StructuralSignals } from "@mergewise/llm-reviewer";
import type { DebtGraph, HotspotEntry } from "./graph-types.ts";

const DEFAULT_TOP_COUNT = 20;

/**
 * Computes a signal density score from structural signals.
 *
 * Combines multiple dimensions into a single numeric score that
 * represents how "complex" or "risky" a file is based on its structure.
 */
export function computeSignalDensity(signals: StructuralSignals, lineCount: number): number {
  if (lineCount === 0) return 0;

  const linesPerFunction = signals.functionCount > 0
    ? signals.maxFunctionLineCount
    : 0;

  return (
    signals.functionCount * 0.3 +
    signals.hookCount * 0.5 +
    signals.maxNestingDepth * 1.0 +
    signals.classCount * 2.0 +
    signals.maxParameterCount * 0.8 +
    signals.typeAssertionCount * 0.3 +
    Math.min(linesPerFunction / 50, 3) * 1.5 +
    Math.min(lineCount / 200, 5) * 0.5
  );
}

/**
 * Ranks files by `centrality x signalDensity` and returns the top N hotspots.
 *
 * @param graph - The scored debt graph.
 * @param topCount - Number of hotspots to return. Defaults to 20.
 * @returns Sorted hotspot entries, highest score first.
 */
export function rankHotspots(
  graph: DebtGraph,
  topCount: number = DEFAULT_TOP_COUNT,
): HotspotEntry[] {
  const entries: HotspotEntry[] = [];

  for (const [nodeId, node] of graph.nodes) {
    const signalDensity = computeSignalDensity(node.signals, node.lineCount);
    const score = node.centrality * signalDensity;

    entries.push({
      nodeId,
      filePath: node.filePath,
      score,
      centrality: node.centrality,
      signalDensity,
      lineCount: node.lineCount,
    });
  }

  entries.sort((left, right) => right.score - left.score);

  return entries.slice(0, topCount);
}
