import type { FileGraphContext, ReviewToolkit } from "@mergewise/llm-reviewer";

import type { DebtGraph, HotspotEntry } from "./graph-types";
import { buildPrGraphContext } from "./graph-context";

const MAX_CALLERS = 50;

/**
 * Builds a {@link ReviewToolkit} from a debt graph and hotspot entries.
 *
 * Maps the debt-scanner's graph context shape to the llm-reviewer's
 * expected `FileGraphContext` interface, capping caller lists to avoid
 * unbounded prompt injection.
 *
 * @param graph - The scored debt graph for the repository.
 * @param hotspots - Ranked hotspot entries from the most recent scan.
 * @returns A toolkit that the review pipeline can query per-file.
 */
export function buildReviewToolkit(
  graph: DebtGraph,
  hotspots: readonly HotspotEntry[],
): ReviewToolkit {
  return {
    getCallers(filePath: string): FileGraphContext {
      const context = buildPrGraphContext([filePath], graph, hotspots);
      const fileContext = context.files[0];
      if (!fileContext) {
        return { filePath, callers: [], centrality: 0, isHotspot: false };
      }
      return {
        filePath: fileContext.filePath,
        callers: fileContext.importedBy.slice(0, MAX_CALLERS),
        centrality: fileContext.centralityScore,
        isHotspot: fileContext.isHotspot,
      };
    },
  };
}
