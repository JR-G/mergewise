import { join } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
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
      console.log(
        `\n${YELLOW}Unmatched findings${RESET} [${result.fixtureId}/${result.variant}]:`,
      );
      for (const finding of score.unmatchedFindings) {
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
