import type { StructuralSignals } from "@mergewise/llm-reviewer";

export interface DebtNode {
  readonly id: string;
  readonly kind: "file" | "function" | "class" | "component";
  readonly filePath: string;
  readonly name?: string;
  readonly signals: StructuralSignals;
  readonly lineCount: number;
  centrality: number;
}

export interface DebtEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: "imports" | "calls" | "renders" | "extends" | "implements";
}

export interface DebtGraph {
  readonly nodes: Map<string, DebtNode>;
  readonly edges: DebtEdge[];
}

export interface DebtFinding {
  readonly nodeId: string;
  readonly patternId: string;
  readonly category: string;
  readonly title: string;
  readonly recommendation: string;
  readonly confidence: number;
  readonly lineRange: readonly [number, number];
}

export interface HotspotEntry {
  readonly nodeId: string;
  readonly filePath: string;
  readonly score: number;
  readonly centrality: number;
  readonly signalDensity: number;
  readonly lineCount: number;
}

export interface DebtProfile {
  readonly repoPath: string;
  readonly scannedAt: string;
  readonly graph: DebtGraph;
  readonly findings: readonly DebtFinding[];
  readonly hotspots: readonly HotspotEntry[];
  readonly totalFiles?: number;
  readonly totalEdges?: number;
}

export interface ScanSummary {
  readonly id: string;
  readonly repoPath: string;
  readonly scannedAt: string;
  readonly totalFiles: number;
  readonly totalEdges: number;
  readonly totalFindings: number;
  readonly hotspotCount: number;
}
