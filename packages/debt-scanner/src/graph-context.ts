import type { DebtGraph, HotspotEntry } from "./graph-types.ts";

export interface FileGraphContext {
  readonly filePath: string;
  readonly centralityScore: number;
  readonly isHotspot: boolean;
  readonly importedBy: readonly string[];
  readonly imports: readonly string[];
}

export interface PrGraphContext {
  readonly files: readonly FileGraphContext[];
  readonly impactSummary: string;
}

const MAX_REVERSE_DEPS = 50;
const HOTSPOT_SCORE_THRESHOLD = 0.5;

/**
 * Builds review context for a set of changed file paths using the debt graph.
 *
 * Returns dependency information, centrality scores, and hotspot status
 * for each changed file, plus a human-readable impact summary suitable
 * for injection into an LLM review prompt.
 *
 * @param changedPaths - Relative file paths from the PR diff.
 * @param graph - The scored debt graph for the repository.
 * @param hotspots - Ranked hotspot entries from the most recent scan.
 * @returns Graph context for the changed files.
 */
export function buildPrGraphContext(
  changedPaths: readonly string[],
  graph: DebtGraph,
  hotspots: readonly HotspotEntry[],
): PrGraphContext {
  const hotspotPaths = new Set(hotspots.map((entry) => entry.filePath));
  const reverseIndex = buildReverseImportIndex(graph);

  const files: FileGraphContext[] = [];

  for (const filePath of changedPaths) {
    const node = graph.nodes.get(filePath);
    const forwardImports = resolveForwardImports(filePath, graph);
    const reverseImports = (reverseIndex.get(filePath) ?? []).slice(0, MAX_REVERSE_DEPS);

    files.push({
      filePath,
      centralityScore: node?.centrality ?? 0,
      isHotspot: hotspotPaths.has(filePath),
      importedBy: reverseImports,
      imports: forwardImports,
    });
  }

  files.sort((left, right) => right.centralityScore - left.centralityScore);

  return {
    files,
    impactSummary: buildImpactSummary(files),
  };
}

/**
 * Formats the graph context as a prompt section for LLM injection.
 *
 * @param context - The PR graph context to format.
 * @returns A markdown-formatted prompt section, or empty string if no context.
 */
export function formatGraphContextPrompt(context: PrGraphContext): string {
  if (context.files.length === 0) return "";

  const lines: string[] = [
    "## Codebase impact context",
    context.impactSummary,
    "",
    "Changed files and their dependencies:",
  ];

  for (const file of context.files) {
    const impact = file.centralityScore >= HOTSPOT_SCORE_THRESHOLD ? "HIGH IMPACT" : "low impact";
    const depCount = file.importedBy.length;
    const depLabel = depCount === 1 ? "1 file" : `${depCount} files`;
    lines.push(
      `- ${file.filePath} (centrality: ${file.centralityScore.toFixed(2)}, imported by ${depLabel}) — ${impact}`,
    );
  }

  const highImpactFiles = context.files.filter((file) => file.centralityScore >= HOTSPOT_SCORE_THRESHOLD);
  if (highImpactFiles.length > 0) {
    lines.push("");
    lines.push(
      "Focus extra scrutiny on high-centrality changes. A bug or bad pattern in a highly-imported file has outsized blast radius.",
    );
  }

  return lines.join("\n");
}

function buildReverseImportIndex(graph: DebtGraph): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;

    const existing = index.get(edge.target);
    if (existing) {
      existing.push(edge.source);
    } else {
      index.set(edge.target, [edge.source]);
    }
  }

  return index;
}

function resolveForwardImports(filePath: string, graph: DebtGraph): string[] {
  const imports: string[] = [];

  for (const edge of graph.edges) {
    if (edge.source === filePath && edge.kind === "imports") {
      imports.push(edge.target);
    }
  }

  return imports;
}

function buildImpactSummary(files: readonly FileGraphContext[]): string {
  const totalReverseDeps = files.reduce((sum, file) => sum + file.importedBy.length, 0);
  const hotspotCount = files.filter((file) => file.isHotspot).length;

  const parts: string[] = [];

  const fileLabel = files.length === 1 ? "1 changed file" : `${files.length} changed files`;
  parts.push(fileLabel);

  if (totalReverseDeps > 0) {
    const depLabel = totalReverseDeps === 1 ? "1 other file" : `${totalReverseDeps} other files`;
    parts.push(`imported by ${depLabel} in total`);
  }

  if (hotspotCount > 0) {
    const hotspotLabel = hotspotCount === 1
      ? "1 is a known debt hotspot"
      : `${hotspotCount} are known debt hotspots`;
    parts.push(hotspotLabel);
  }

  return `${parts.join(", ")}.`;
}
