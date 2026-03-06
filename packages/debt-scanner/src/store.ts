import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  DebtProfile,
  DebtFinding,
  HotspotEntry,
  ScanSummary,
} from "./graph-types";

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
  database.run(SCHEMA_HOTSPOTS);
  database.run(SCHEMA_FINDINGS);
}

function reconstructProfile(
  scanRow: ScanRow,
  queryHotspots: ReturnType<Database["prepare"]>,
  queryFindings: ReturnType<Database["prepare"]>,
): DebtProfile {
  const hotspotRows = queryHotspots.all(scanRow.id) as HotspotRow[];
  const findingRows = queryFindings.all(scanRow.id) as FindingRow[];

  return {
    repoPath: scanRow.repo_path,
    scannedAt: scanRow.scanned_at,
    graph: { nodes: new Map(), edges: [] },
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
  insertHotspot: ReturnType<Database["prepare"]>;
  insertFinding: ReturnType<Database["prepare"]>;
  queryScans: ReturnType<Database["prepare"]>;
  queryScansByRepo: ReturnType<Database["prepare"]>;
  queryScanById: ReturnType<Database["prepare"]>;
  queryLatestByRepo: ReturnType<Database["prepare"]>;
  queryHotspots: ReturnType<Database["prepare"]>;
  queryFindings: ReturnType<Database["prepare"]>;
}

function prepareStatements(database: Database): Statements {
  return {
    insertScan: database.prepare(
      `INSERT INTO scans (id, repo_path, scanned_at, total_files, total_edges, total_findings, hotspot_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
    queryHotspots: database.prepare(
      "SELECT node_id, file_path, score, centrality, signal_density, line_count FROM hotspots WHERE scan_id = ? ORDER BY score DESC LIMIT 500",
    ),
    queryFindings: database.prepare(
      "SELECT node_id, pattern_id, category, title, recommendation, confidence, line_start, line_end FROM findings WHERE scan_id = ? LIMIT 2000",
    ),
  };
}

function executeSave(stmts: Statements, database: Database, profile: DebtProfile): string {
  const scanId = randomUUID();

  database.transaction(() => {
    stmts.insertScan.run(
      scanId, profile.repoPath, profile.scannedAt,
      profile.graph.nodes.size, profile.graph.edges.length,
      profile.findings.length, profile.hotspots.length,
    );

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
  return reconstructProfile(scanRow, stmts.queryHotspots, stmts.queryFindings);
}

function executeLatest(stmts: Statements, repoPath: string): DebtProfile | null {
  const scanRow = stmts.queryLatestByRepo.get(repoPath) as ScanRow | undefined;
  if (!scanRow) return null;
  return reconstructProfile(scanRow, stmts.queryHotspots, stmts.queryFindings);
}
