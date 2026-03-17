import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  DebtProfile,
  DebtFinding,
  DebtNode,
  DebtEdge,
  HotspotEntry,
  ScanSummary,
} from "./graph-types";
import type { StructuralSignals } from "@mergewise/llm-reviewer";

export interface DebtStore {
  saveScan(profile: DebtProfile): string;
  listScans(repoPath?: string): ScanSummary[];
  loadScan(scanId: string): DebtProfile | null;
  latestScan(repoPath: string): DebtProfile | null;
  close(): void;
}

const SCHEMA_SCANS = `CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  total_files INTEGER NOT NULL,
  total_edges INTEGER NOT NULL,
  total_findings INTEGER NOT NULL,
  hotspot_count INTEGER NOT NULL
)`;

const SCHEMA_HOTSPOTS = `CREATE TABLE IF NOT EXISTS hotspots (
  scan_id TEXT NOT NULL REFERENCES scans(id),
  node_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  score REAL NOT NULL,
  centrality REAL NOT NULL,
  signal_density REAL NOT NULL,
  line_count INTEGER NOT NULL,
  PRIMARY KEY (scan_id, node_id)
)`;

const SCHEMA_NODES = `CREATE TABLE IF NOT EXISTS nodes (
  scan_id TEXT NOT NULL REFERENCES scans(id),
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  name TEXT,
  signals_json TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  centrality REAL NOT NULL,
  PRIMARY KEY (scan_id, node_id)
)`;

const SCHEMA_EDGES = `CREATE TABLE IF NOT EXISTS edges (
  scan_id TEXT NOT NULL REFERENCES scans(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (scan_id, source_id, target_id, kind)
)`;

const SCHEMA_FINDINGS = `CREATE TABLE IF NOT EXISTS findings (
  scan_id TEXT NOT NULL REFERENCES scans(id),
  node_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  confidence REAL NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  PRIMARY KEY (scan_id, node_id, pattern_id, line_start)
)`;

interface ScanRow {
  id: string;
  repo_path: string;
  scanned_at: string;
  total_files: number;
  total_edges: number;
  total_findings: number;
  hotspot_count: number;
}

interface HotspotRow {
  node_id: string;
  file_path: string;
  score: number;
  centrality: number;
  signal_density: number;
  line_count: number;
}

interface NodeRow {
  node_id: string;
  kind: string;
  file_path: string;
  name: string | null;
  signals_json: string;
  line_count: number;
  centrality: number;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  kind: string;
}

interface FindingRow {
  node_id: string;
  pattern_id: string;
  category: string;
  title: string;
  recommendation: string;
  confidence: number;
  line_start: number;
  line_end: number;
}

function toSummary(row: ScanRow): ScanSummary {
  return {
    id: row.id,
    repoPath: row.repo_path,
    scannedAt: row.scanned_at,
    totalFiles: row.total_files,
    totalEdges: row.total_edges,
    totalFindings: row.total_findings,
    hotspotCount: row.hotspot_count,
  };
}

function toHotspot(row: HotspotRow): HotspotEntry {
  return {
    nodeId: row.node_id,
    filePath: row.file_path,
    score: row.score,
    centrality: row.centrality,
    signalDensity: row.signal_density,
    lineCount: row.line_count,
  };
}

function toNode(row: NodeRow): DebtNode {
  const base = {
    id: row.node_id,
    kind: row.kind as DebtNode["kind"],
    filePath: row.file_path,
    signals: JSON.parse(row.signals_json) as StructuralSignals,
    lineCount: row.line_count,
    centrality: row.centrality,
  };
  if (row.name !== null) {
    return { ...base, name: row.name };
  }
  return base;
}

function toEdge(row: EdgeRow): DebtEdge {
  return {
    source: row.source_id,
    target: row.target_id,
    kind: row.kind as DebtEdge["kind"],
  };
}

function toFinding(row: FindingRow): DebtFinding {
  return {
    nodeId: row.node_id,
    patternId: row.pattern_id,
    category: row.category,
    title: row.title,
    recommendation: row.recommendation,
    confidence: row.confidence,
    lineRange: [row.line_start, row.line_end] as const,
  };
}

function initSchema(database: Database): void {
  database.run("PRAGMA journal_mode = WAL;");
  database.run("PRAGMA foreign_keys = ON;");
  database.run(SCHEMA_SCANS);
  database.run(SCHEMA_NODES);
  database.run(SCHEMA_EDGES);
  database.run(SCHEMA_HOTSPOTS);
  database.run(SCHEMA_FINDINGS);
}

interface ReconstructQueries {
  readonly queryNodes: ReturnType<Database["prepare"]>;
  readonly queryEdges: ReturnType<Database["prepare"]>;
  readonly queryHotspots: ReturnType<Database["prepare"]>;
  readonly queryFindings: ReturnType<Database["prepare"]>;
}

function reconstructProfile(
  scanRow: ScanRow,
  queries: ReconstructQueries,
): DebtProfile {
  const nodeRows = queries.queryNodes.all(scanRow.id) as NodeRow[];
  const edgeRows = queries.queryEdges.all(scanRow.id) as EdgeRow[];
  const hotspotRows = queries.queryHotspots.all(scanRow.id) as HotspotRow[];
  const findingRows = queries.queryFindings.all(scanRow.id) as FindingRow[];

  const nodes = new Map<string, DebtNode>();
  for (const row of nodeRows) {
    const node = toNode(row);
    nodes.set(node.id, node);
  }

  return {
    repoPath: scanRow.repo_path,
    scannedAt: scanRow.scanned_at,
    graph: { nodes, edges: edgeRows.map(toEdge) },
    findings: findingRows.map(toFinding),
    hotspots: hotspotRows.map(toHotspot),
    totalFiles: scanRow.total_files,
    totalEdges: scanRow.total_edges,
  };
}

/**
 * Opens (or creates) a SQLite-backed debt store at the given path.
 */
export function openStore(dbPath: string): DebtStore {
  const database = new Database(dbPath, { create: true });
  initSchema(database);

  const stmts = prepareStatements(database);

  return {
    saveScan: (profile) => executeSave(stmts, database, profile),
    listScans: (repoPath) => executeList(stmts, repoPath),
    loadScan: (scanId) => executeLoad(stmts, scanId),
    latestScan: (repoPath) => executeLatest(stmts, repoPath),
    close: (): void => { database.close(); },
  };
}

interface Statements {
  insertScan: ReturnType<Database["prepare"]>;
  insertNode: ReturnType<Database["prepare"]>;
  insertEdge: ReturnType<Database["prepare"]>;
  insertHotspot: ReturnType<Database["prepare"]>;
  insertFinding: ReturnType<Database["prepare"]>;
  queryScans: ReturnType<Database["prepare"]>;
  queryScansByRepo: ReturnType<Database["prepare"]>;
  queryScanById: ReturnType<Database["prepare"]>;
  queryLatestByRepo: ReturnType<Database["prepare"]>;
  queryNodes: ReturnType<Database["prepare"]>;
  queryEdges: ReturnType<Database["prepare"]>;
  queryHotspots: ReturnType<Database["prepare"]>;
  queryFindings: ReturnType<Database["prepare"]>;
}

function prepareStatements(database: Database): Statements {
  return {
    insertScan: database.prepare(
      `INSERT INTO scans (id, repo_path, scanned_at, total_files, total_edges, total_findings, hotspot_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertNode: database.prepare(
      `INSERT INTO nodes (scan_id, node_id, kind, file_path, name, signals_json, line_count, centrality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertEdge: database.prepare(
      `INSERT OR IGNORE INTO edges (scan_id, source_id, target_id, kind)
       VALUES (?, ?, ?, ?)`,
    ),
    insertHotspot: database.prepare(
      `INSERT INTO hotspots (scan_id, node_id, file_path, score, centrality, signal_density, line_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertFinding: database.prepare(
      `INSERT OR IGNORE INTO findings (scan_id, node_id, pattern_id, category, title, recommendation, confidence, line_start, line_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    queryScans: database.prepare("SELECT * FROM scans ORDER BY scanned_at DESC LIMIT 100"),
    queryScansByRepo: database.prepare("SELECT * FROM scans WHERE repo_path = ? ORDER BY scanned_at DESC LIMIT 100"),
    queryScanById: database.prepare("SELECT * FROM scans WHERE id = ? LIMIT 1"),
    queryLatestByRepo: database.prepare("SELECT * FROM scans WHERE repo_path = ? ORDER BY scanned_at DESC LIMIT 1"),
    queryNodes: database.prepare(
      "SELECT node_id, kind, file_path, name, signals_json, line_count, centrality FROM nodes WHERE scan_id = ? ORDER BY node_id ASC LIMIT 10000",
    ),
    queryEdges: database.prepare(
      "SELECT source_id, target_id, kind FROM edges WHERE scan_id = ? ORDER BY source_id ASC, target_id ASC, kind ASC LIMIT 50000",
    ),
    queryHotspots: database.prepare(
      "SELECT node_id, file_path, score, centrality, signal_density, line_count FROM hotspots WHERE scan_id = ? ORDER BY score DESC LIMIT 500",
    ),
    queryFindings: database.prepare(
      "SELECT node_id, pattern_id, category, title, recommendation, confidence, line_start, line_end FROM findings WHERE scan_id = ? LIMIT 2000",
    ),
  };
}

const MAX_PERSISTED_NODES = 10_000;
const MAX_PERSISTED_EDGES = 50_000;

function executeSave(stmts: Statements, database: Database, profile: DebtProfile): string {
  const scanId = randomUUID();

  const nodeEntries = Array.from(profile.graph.nodes.values())
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_PERSISTED_NODES);
  const edges = profile.graph.edges.slice(0, MAX_PERSISTED_EDGES);

  database.transaction(() => {
    stmts.insertScan.run(
      scanId, profile.repoPath, profile.scannedAt,
      nodeEntries.length, edges.length,
      profile.findings.length, profile.hotspots.length,
    );

    for (const node of nodeEntries) {
      stmts.insertNode.run(
        scanId, node.id, node.kind, node.filePath,
        node.name ?? null, JSON.stringify(node.signals),
        node.lineCount, node.centrality,
      );
    }

    for (const edge of edges) {
      stmts.insertEdge.run(scanId, edge.source, edge.target, edge.kind);
    }

    for (const hotspot of profile.hotspots) {
      stmts.insertHotspot.run(
        scanId, hotspot.nodeId, hotspot.filePath,
        hotspot.score, hotspot.centrality, hotspot.signalDensity, hotspot.lineCount,
      );
    }

    for (const finding of profile.findings) {
      stmts.insertFinding.run(
        scanId, finding.nodeId, finding.patternId, finding.category,
        finding.title, finding.recommendation, finding.confidence,
        finding.lineRange[0], finding.lineRange[1],
      );
    }
  })();

  return scanId;
}

function executeList(stmts: Statements, repoPath?: string): ScanSummary[] {
  const rows = repoPath
    ? stmts.queryScansByRepo.all(repoPath) as ScanRow[]
    : stmts.queryScans.all() as ScanRow[];
  return rows.map(toSummary);
}

function executeLoad(stmts: Statements, scanId: string): DebtProfile | null {
  const scanRow = stmts.queryScanById.get(scanId) as ScanRow | undefined;
  if (!scanRow) return null;
  return reconstructProfile(scanRow, stmts);
}

function executeLatest(stmts: Statements, repoPath: string): DebtProfile | null {
  const scanRow = stmts.queryLatestByRepo.get(repoPath) as ScanRow | undefined;
  if (!scanRow) return null;
  return reconstructProfile(scanRow, stmts);
}
