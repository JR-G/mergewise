export type {
  DebtNode,
  DebtEdge,
  DebtGraph,
  DebtFinding,
  DebtProfile,
  HotspotEntry,
  ScanSummary,
} from "./graph-types.ts";
export { collectFiles } from "./file-collector.ts";
export { analyseFile, analyseFiles } from "./ast-analyser.ts";
export { buildGraph } from "./graph-builder.ts";
export { computeCentrality } from "./centrality.ts";
export { rankHotspots, computeSignalDensity } from "./hotspot-ranker.ts";
export { scanWithLlm } from "./llm-scanner.ts";
export { scan, type ScanOptions } from "./scanner.ts";
export { formatJsonReport, formatMarkdownReport, formatComparisonMarkdown, formatComparisonJson } from "./report.ts";
export { openStore, type DebtStore } from "./store.ts";
export { compareScans, type ScanComparison, type HotspotChange, type TrendDirection } from "./compare.ts";

import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import type { ScanSummary } from "./graph-types.ts";
import { scan, type ScanOptions } from "./scanner.ts";
import { formatJsonReport, formatMarkdownReport, formatComparisonMarkdown, formatComparisonJson } from "./report.ts";
import { openStore, type DebtStore } from "./store.ts";
import { compareScans } from "./compare.ts";

const DEFAULT_DB_PATH = ".mergewise-runtime/debt.db";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printHistory(scans: ScanSummary[]): void {
  if (scans.length === 0) {
    writeLine("No previous scans found.");
    return;
  }

  writeLine("| # | Scan ID | Date | Files | Findings | Hotspots |");
  writeLine("| -: | ------- | ---- | ----: | -------: | -------: |");
  for (const [index, entry] of scans.entries()) {
    const date = entry.scannedAt.split("T")[0] ?? entry.scannedAt;
    writeLine(
      `| ${index + 1} | ${entry.id.slice(0, 8)} | ${date} | ${entry.totalFiles} | ${entry.totalFindings} | ${entry.hotspotCount} |`,
    );
  }
}

interface ParsedArgs {
  repoPath: string;
  topCount: number;
  format: string;
  skipLlm: boolean;
  dbPath: string;
  compare: boolean;
  history: boolean;
  apiKey: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
}

function parseCliArgs(): ParsedArgs {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string", default: "." },
      top: { type: "string", default: "20" },
      format: { type: "string", default: "markdown" },
      "no-llm": { type: "boolean", default: false },
      model: { type: "string" },
      "api-key": { type: "string" },
      "base-url": { type: "string" },
      db: { type: "string", default: DEFAULT_DB_PATH },
      compare: { type: "boolean", default: false },
      history: { type: "boolean", default: false },
    },
    strict: true,
  });

  return {
    repoPath: resolve(values.repo),
    topCount: parseInt(values.top, 10),
    format: values.format,
    skipLlm: values["no-llm"],
    dbPath: resolve(values.db),
    compare: values.compare,
    history: values.history,
    apiKey: values["api-key"] ?? process.env.LLM_EVAL_API_KEY ?? process.env.OPENAI_API_KEY,
    model: values.model ?? process.env.LLM_EVAL_MODEL,
    baseUrl: values["base-url"] ?? process.env.LLM_EVAL_BASE_URL,
  };
}

async function runScan(args: ParsedArgs, store: DebtStore): Promise<void> {
  const previousProfile = args.compare
    ? store.latestScan(args.repoPath)
    : null;

  const scanOptions: ScanOptions = {
    repoPath: args.repoPath,
    topCount: args.topCount,
    skipLlm: args.skipLlm || !args.apiKey,
    clientConfig: args.apiKey
      ? { apiKey: args.apiKey, model: args.model, baseUrl: args.baseUrl }
      : undefined,
    store,
    onProgress: (_stage, detail) => {
      console.error(detail);
    },
  };

  const profile = await scan(scanOptions);

  let output = args.format === "json"
    ? formatJsonReport(profile)
    : formatMarkdownReport(profile);

  if (args.compare && previousProfile) {
    const comparison = compareScans(previousProfile, profile);
    output += "\n\n";
    output += args.format === "json"
      ? formatComparisonJson(comparison)
      : formatComparisonMarkdown(comparison);
  } else if (args.compare) {
    console.error("No previous scan found for comparison.");
  }

  writeLine(output);
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  mkdirSync(dirname(args.dbPath), { recursive: true });
  const store = openStore(args.dbPath);

  try {
    if (args.history) {
      printHistory(store.listScans(args.repoPath));
      return;
    }

    await runScan(args, store);
  } finally {
    store.close();
  }
}

const isDirectExecution = import.meta.path === Bun.main;
if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
