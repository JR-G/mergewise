import type { ReviewClientConfig } from "@mergewise/llm-reviewer";
import { collectFiles } from "./file-collector";
import { analyseFiles } from "./ast-analyser";
import { buildGraph } from "./graph-builder";
import { computeCentrality } from "./centrality";
import { rankHotspots } from "./hotspot-ranker";
import { scanWithLlm } from "./llm-scanner";
import type { DebtProfile, DebtFinding } from "./graph-types";
import type { DebtStore } from "./store";

export interface ScanOptions {
  readonly repoPath: string;
  readonly topCount?: number | undefined;
  readonly skipLlm?: boolean | undefined;
  readonly clientConfig?: ReviewClientConfig | undefined;
  readonly tokenBudget?: number | undefined;
  readonly store?: DebtStore | undefined;
  readonly onProgress?: ((stage: string, detail: string) => void) | undefined;
}

const DEFAULT_TOP_COUNT = 20;
const MAX_TOP_COUNT = 100;

/**
 * Runs the full three-tier debt scan pipeline.
 *
 * @param options - Configuration for the scan.
 * @returns A complete debt profile for the repository.
 */
export async function scan(options: ScanOptions): Promise<DebtProfile> {
  const { repoPath, onProgress } = options;
  const rawTop = options.topCount ?? DEFAULT_TOP_COUNT;
  const validTop = Number.isFinite(rawTop) ? Math.trunc(rawTop) : DEFAULT_TOP_COUNT;
  const topCount = Math.min(Math.max(validTop, 1), MAX_TOP_COUNT);

  onProgress?.("collect", "Collecting files...");
  const filePaths = await collectFiles(repoPath);
  onProgress?.("collect", `Found ${filePaths.length} TypeScript files`);

  onProgress?.("analyse", "Analysing AST and extracting signals...");
  const nodes = await analyseFiles(filePaths, repoPath);
  onProgress?.("analyse", `Analysed ${nodes.length} files`);

  onProgress?.("graph", "Building dependency graph...");
  const graph = await buildGraph(nodes, repoPath);
  onProgress?.("graph", `Built graph with ${graph.nodes.size} nodes and ${graph.edges.length} edges`);

  onProgress?.("centrality", "Computing centrality scores...");
  computeCentrality(graph);
  onProgress?.("centrality", "Centrality computed");

  onProgress?.("rank", "Ranking hotspots...");
  const hotspots = rankHotspots(graph, topCount);
  onProgress?.("rank", `Top ${hotspots.length} hotspots ranked`);

  let findings: DebtFinding[] = [];

  if (!options.skipLlm && options.clientConfig) {
    onProgress?.("llm", `Scanning top ${hotspots.length} hotspots with LLM...`);
    findings = await scanWithLlm(hotspots, repoPath, {
      clientConfig: options.clientConfig,
      tokenBudget: options.tokenBudget,
      onFileComplete: (filePath, count) => {
        onProgress?.("llm", `${filePath}: ${count} findings`);
      },
      onFileError: (filePath, error) => {
        onProgress?.("llm", `${filePath}: error — ${String(error)}`);
      },
    });
    onProgress?.("llm", `LLM scan complete: ${findings.length} findings`);
  }

  const profile: DebtProfile = {
    repoPath,
    scannedAt: new Date().toISOString(),
    graph,
    findings,
    hotspots,
  };

  if (options.store) {
    const scanId = options.store.saveScan(profile);
    onProgress?.("store", `Scan saved: ${scanId}`);
  }

  return profile;
}
