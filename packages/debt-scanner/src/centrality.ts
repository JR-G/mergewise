import type { DebtGraph } from "./graph-types.ts";

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 1e-6;

/**
 * Computes PageRank centrality scores on the import graph.
 *
 * Files that are imported by many other files (especially high-centrality ones)
 * receive higher scores. Mutates `centrality` on each `DebtNode` in place.
 *
 * @param graph - The debt graph to score.
 * @param damping - PageRank damping factor. Defaults to 0.85.
 * @param iterations - Maximum number of iterations. Defaults to 20.
 */
export function computeCentrality(
  graph: DebtGraph,
  damping: number = DEFAULT_DAMPING,
  iterations: number = DEFAULT_ITERATIONS,
): void {
  const nodeIds = [...graph.nodes.keys()];
  const nodeCount = nodeIds.length;

  if (nodeCount === 0) return;

  const outDegree = new Map<string, number>();
  const inEdges = new Map<string, string[]>();

  for (const nodeId of nodeIds) {
    outDegree.set(nodeId, 0);
    inEdges.set(nodeId, []);
  }

  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.source) || !graph.nodes.has(edge.target)) continue;
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1);
    inEdges.get(edge.target)?.push(edge.source);
  }

  const uniformScore = 1 / nodeCount;
  let scores = new Map<string, number>();
  for (const nodeId of nodeIds) {
    scores.set(nodeId, uniformScore);
  }

  const teleport = (1 - damping) / nodeCount;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const nextScores = new Map<string, number>();
    let maxDelta = 0;

    for (const nodeId of nodeIds) {
      let incoming = 0;
      const predecessors = inEdges.get(nodeId) ?? [];

      for (const predecessor of predecessors) {
        const predecessorScore = scores.get(predecessor) ?? 0;
        const predecessorOutDegree = outDegree.get(predecessor) ?? 1;
        incoming += predecessorScore / predecessorOutDegree;
      }

      const newScore = teleport + damping * incoming;
      nextScores.set(nodeId, newScore);

      const delta = Math.abs(newScore - (scores.get(nodeId) ?? 0));
      if (delta > maxDelta) maxDelta = delta;
    }

    scores = nextScores;

    if (maxDelta < CONVERGENCE_THRESHOLD) break;
  }

  for (const [nodeId, score] of scores) {
    const node = graph.nodes.get(nodeId);
    if (node) {
      node.centrality = score;
    }
  }
}
