import type { Finding } from "@mergewise/shared-types";

const LINE_PROXIMITY_THRESHOLD = 5;
const JACCARD_SIMILARITY_THRESHOLD = 0.4;
const MAX_FINDINGS_PER_RUN = 50;
const MAX_TOTAL_FINDINGS = 500;

/**
 * Extracts whitespace-separated word tokens from a string, lowercased.
 *
 * @param text - Input string to tokenise.
 * @returns Set of lowercase word tokens.
 */
export function extractWordTokens(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  return new Set(matches ?? []);
}

/**
 * Computes Jaccard similarity between two token sets.
 *
 * @param left - First token set.
 * @param right - Second token set.
 * @returns Similarity coefficient between 0 and 1.
 */
export function jaccardSimilarity(
  left: Set<string>,
  right: Set<string>,
): number {
  if (left.size === 0 && right.size === 0) return 1;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface FindingWithTokens {
  readonly finding: Finding;
  readonly tokens: Set<string>;
}

interface ConsensusCluster {
  readonly members: FindingWithTokens[];
  readonly runIndices: Set<number>;
}

/**
 * Determines whether two findings refer to the same concern.
 *
 * @remarks
 * Matches on same file path, lines within ±5, and recommendation
 * word-token Jaccard similarity above 0.4.
 */
function isSameConcern(
  left: FindingWithTokens,
  right: FindingWithTokens,
): boolean {
  if (left.finding.filePath !== right.finding.filePath) return false;
  if (Math.abs(left.finding.line - right.finding.line) > LINE_PROXIMITY_THRESHOLD) return false;
  return jaccardSimilarity(left.tokens, right.tokens) > JACCARD_SIMILARITY_THRESHOLD;
}

/**
 * Applies self-consistency consensus filtering across multiple LLM runs.
 *
 * @remarks
 * Clusters findings from N runs that refer to the same concern (same file,
 * lines within ±5, recommendation Jaccard similarity above 0.4). Keeps only
 * clusters that appear in more than 50% of runs. From each surviving cluster,
 * picks the finding with the highest confidence as representative.
 *
 * @param findingSets - Array of finding arrays, one per LLM run.
 * @returns Consensus findings that appeared in the majority of runs.
 */
export function applyConsensusFilter(
  findingSets: readonly (readonly Finding[])[],
): Finding[] {
  const totalRuns = findingSets.length;
  if (totalRuns === 0) return [];

  const firstRun = findingSets[0];
  if (totalRuns === 1 && firstRun) return [...firstRun];

  const clusters: ConsensusCluster[] = [];
  let totalProcessed = 0;

  for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
    if (totalProcessed >= MAX_TOTAL_FINDINGS) break;

    const rawRunFindings = findingSets[runIndex] ?? [];
    const runFindings = rawRunFindings.slice(0, MAX_FINDINGS_PER_RUN);
    for (const finding of runFindings) {
      if (totalProcessed >= MAX_TOTAL_FINDINGS) break;
      totalProcessed += 1;
      const tokens = extractWordTokens(finding.recommendation);
      const tagged: FindingWithTokens = { finding, tokens };

      let matched = false;
      for (const cluster of clusters) {
        const matchesCluster = cluster.members.some(
          (member) => isSameConcern(member, tagged),
        );
        if (matchesCluster) {
          cluster.members.push(tagged);
          cluster.runIndices.add(runIndex);
          matched = true;
          break;
        }
      }

      if (!matched) {
        clusters.push({
          members: [tagged],
          runIndices: new Set([runIndex]),
        });
      }
    }
  }

  const threshold = totalRuns / 2;
  const representatives: Finding[] = [];

  for (const cluster of clusters) {
    if (cluster.runIndices.size <= threshold) continue;

    let best: Finding | undefined;
    for (const member of cluster.members) {
      if (!best || member.finding.confidence > best.confidence) {
        best = member.finding;
      }
    }
    if (best) representatives.push(best);
  }

  return representatives;
}
