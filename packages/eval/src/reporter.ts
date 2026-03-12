import { join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { Finding } from "@mergewise/shared-types";
import type { EvalResult, RunRecord } from "./types";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");
const RUNS_FILE = join(RESULTS_DIR, "runs.ndjson");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ANSI_OVERHEAD = 9;

function colourScore(value: number): string {
  if (value >= 0.8) return `${GREEN}${value.toFixed(2)}${RESET}`;
  if (value >= 0.5) return `${YELLOW}${value.toFixed(2)}${RESET}`;
  return `${RED}${value.toFixed(2)}${RESET}`;
}

/**
 * Prints a formatted eval report to stdout.
 *
 * @param results - Evaluation results to display.
 */
export function printReport(results: readonly EvalResult[]): void {
  console.log("\n=== Eval Report ===\n");

  const header = `${"Fixture".padEnd(25)} ${"Variant".padEnd(18)} ${"Recall".padEnd(14)} ${"Precision".padEnd(14)} ${"Findings".padEnd(10)} ${"FP".padEnd(6)} ${"Duration".padEnd(10)}`;
  console.log(header);
  console.log("─".repeat(105));

  for (const result of results) {
    const fpDisplay = result.score.falsePositiveCount > 0
      ? `${RED}${result.score.falsePositiveCount}${RESET}`
      : `${DIM}0${RESET}`;
    const line = `${result.fixtureId.padEnd(25)} ${result.variant.padEnd(18)} ${colourScore(result.score.recall).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(result.score.precision).padEnd(14 + ANSI_OVERHEAD)} ${String(result.score.totalFindings).padEnd(10)} ${fpDisplay.padEnd(6 + ANSI_OVERHEAD)} ${DIM}${result.durationMs}ms${RESET}`;
    console.log(line);
  }

  for (const result of results) {
    const { score } = result;

    if (score.recall < 1.0) {
      const missed = result.score.requiredExpectations - result.score.requiredMatched;
      console.log(
        `\n${RED}Missed expectations${RESET} [${result.fixtureId}/${result.variant}]: ${missed} of ${score.requiredExpectations} required`,
      );
    }

    if (score.unmatchedFindings.length > 0) {
      printUnmatchedFindings(result.fixtureId, result.variant, score.unmatchedFindings);
    }
  }

  console.log();
}

function printUnmatchedFindings(
  fixtureId: string,
  variant: string,
  findings: readonly Finding[],
): void {
  console.log(
    `\n${YELLOW}Unmatched findings${RESET} [${fixtureId}/${variant}]:`,
  );
  for (const finding of findings) {
    console.log(
      `  L${finding.line} [${finding.category}] ${finding.evidence.slice(0, 80)}`,
    );
    if (finding.recommendation) {
      console.log(
        `  ${DIM}→ ${finding.recommendation.slice(0, 100)}${RESET}`,
      );
    }
  }
}

interface MultiRunSummary {
  readonly fixtureId: string;
  readonly variant: string;
  readonly meanRecall: number;
  readonly fullRecallRate: number;
  readonly meanPrecision: number;
  readonly runs: number;
}

function summariseRuns(
  allResults: readonly (readonly EvalResult[])[],
): readonly MultiRunSummary[] {
  const grouped = new Map<string, EvalResult[]>();

  for (const results of allResults) {
    for (const result of results) {
      const key = `${result.fixtureId}::${result.variant}`;
      const group = grouped.get(key);
      if (group) {
        group.push(result);
      } else {
        grouped.set(key, [result]);
      }
    }
  }

  const summaries: MultiRunSummary[] = [];

  for (const results of grouped.values()) {
    const totalRuns = results.length;
    const recallSum = results.reduce((sum, result) => sum + result.score.recall, 0);
    const precisionSum = results.reduce((sum, result) => sum + result.score.precision, 0);
    const fullRecallCount = results.filter((result) => result.score.recall === 1.0).length;

    const firstResult = results[0];
    if (!firstResult) continue;

    summaries.push({
      fixtureId: firstResult.fixtureId,
      variant: firstResult.variant,
      meanRecall: recallSum / totalRuns,
      fullRecallRate: fullRecallCount / totalRuns,
      meanPrecision: precisionSum / totalRuns,
      runs: totalRuns,
    });
  }

  return summaries;
}

/**
 * Prints a multi-run eval report with mean recall and P(full recall).
 *
 * @param allResults - Array of result arrays, one per run.
 */
export function printMultiRunReport(
  allResults: readonly (readonly EvalResult[])[],
): void {
  console.log(`\n=== Eval Report (${allResults.length} runs) ===\n`);

  const summaries = summariseRuns(allResults);

  const header = `${"Fixture".padEnd(25)} ${"Variant".padEnd(18)} ${"Mean Recall".padEnd(16)} ${"P(full)".padEnd(14)} ${"Mean Prec.".padEnd(14)} ${"Runs".padEnd(6)}`;
  console.log(header);
  console.log("─".repeat(95));

  for (const summary of summaries) {
    const line = `${summary.fixtureId.padEnd(25)} ${summary.variant.padEnd(18)} ${colourScore(summary.meanRecall).padEnd(16 + ANSI_OVERHEAD)} ${colourScore(summary.fullRecallRate).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(summary.meanPrecision).padEnd(14 + ANSI_OVERHEAD)} ${String(summary.runs).padEnd(6)}`;
    console.log(line);
  }

  console.log();
}

/**
 * Appends a run record as NDJSON to the results file.
 *
 * @param results - Evaluation results to persist.
 * @param path - Output file path. Defaults to results/runs.ndjson.
 */
export async function appendRunRecord(
  results: readonly EvalResult[],
  path: string = RUNS_FILE,
): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true });

  const record: RunRecord = {
    timestamp: new Date().toISOString(),
    results,
  };

  await appendFile(path, JSON.stringify(record) + "\n");
}
