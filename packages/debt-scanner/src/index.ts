export type {
  DebtNode,
  DebtEdge,
  DebtGraph,
  DebtFinding,
  DebtProfile,
  HotspotEntry,
  ScanSummary,
} from "./graph-types";
export { collectFiles } from "./file-collector";
export { analyseFile, analyseFiles } from "./ast-analyser";
export { buildGraph } from "./graph-builder";
export { computeCentrality } from "./centrality";
export { rankHotspots, computeSignalDensity } from "./hotspot-ranker";
export { scanWithLlm } from "./llm-scanner";
export { indexSymbols } from "./symbol-index";
export { scan, type ScanOptions } from "./scanner";
export { formatJsonReport, formatMarkdownReport, formatComparisonMarkdown, formatComparisonJson } from "./report";
export { openStore, type DebtStore } from "./store";
export { compareScans, type ScanComparison, type HotspotChange, type TrendDirection } from "./compare";
export { buildPrGraphContext, formatGraphContextPrompt, type FileGraphContext, type PrGraphContext } from "./graph-context";
export { buildReviewToolkit } from "./toolkit-adapter";

import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import type { DebtProfile, ScanSummary } from "./graph-types";
import { scan, type ScanOptions } from "./scanner";
import { formatJsonReport, formatMarkdownReport, formatComparisonMarkdown, formatComparisonJson } from "./report";
import { openStore, type DebtStore } from "./store";
import { compareScans, type ScanComparison } from "./compare";

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

  const parsedTop = parseInt(values.top, 10);
  if (!Number.isFinite(parsedTop) || parsedTop < 1) {
    console.error(`Invalid --top value: "${values.top}". Must be a positive integer.`);
    process.exit(1);
  }

  const allowedFormats = ["json", "markdown"];
  if (!allowedFormats.includes(values.format)) {
    console.error(`Invalid --format value: "${values.format}". Must be one of: ${allowedFormats.join(", ")}`);
    process.exit(1);
  }

  return {
    repoPath: resolve(values.repo),
    topCount: parsedTop,
    format: values.format,
    skipLlm: values["no-llm"],
    dbPath: resolve(values.db),
    compare: values.compare,
    history: values.history,
    apiKey: values["api-key"] ?? process.env["LLM_EVAL_API_KEY"] ?? process.env["OPENAI_API_KEY"],
    model: values.model ?? process.env["LLM_EVAL_MODEL"],
    baseUrl: values["base-url"] ?? process.env["LLM_EVAL_BASE_URL"],
  };
}

function buildJsonOutput(profile: DebtProfile, comparison: ScanComparison | null): string {
  const payload: Record<string, unknown> = {
    report: JSON.parse(formatJsonReport(profile)) as unknown,
  };
  if (comparison) payload["comparison"] = JSON.parse(formatComparisonJson(comparison)) as unknown;
  return JSON.stringify(payload, null, 2);
}

function buildMarkdownOutput(profile: DebtProfile, comparison: ScanComparison | null): string {
  const parts = [formatMarkdownReport(profile)];
  if (comparison) parts.push(formatComparisonMarkdown(comparison));
  return parts.join("\n\n");
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

  const comparison = args.compare && previousProfile
    ? compareScans(previousProfile, profile)
    : null;

  if (args.compare && !previousProfile) {
    console.error("No previous scan found for comparison.");
  }

  const output = args.format === "json"
    ? buildJsonOutput(profile, comparison)
    : buildMarkdownOutput(profile, comparison);

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
