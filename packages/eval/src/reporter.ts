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
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function colourScore(value: number): string {
  if (value >= 0.8) return `${GREEN}${value.toFixed(2)}${RESET}`;
  if (value >= 0.5) return `${YELLOW}${value.toFixed(2)}${RESET}`;
  return `${RED}${value.toFixed(2)}${RESET}`;
}

function formatExecutionMode(result: EvalResult): string {
  return result.executionMode === "pipeline" ? `${CYAN}pipeline${RESET}` : `${DIM}legacy${RESET}`;
}

function printRunSummary(results: readonly EvalResult[]): void {
  const pipelineRuns = results.filter((result) => result.executionMode === "pipeline");
  const qualityRuns = pipelineRuns.filter((result) => result.reviewQuality !== null);
  const meanQuality = qualityRuns.length === 0
    ? null
    : qualityRuns.reduce((sum, result) => sum + (result.reviewQuality?.overall ?? 0), 0) / qualityRuns.length;
  const regressionMeanRecall = results.length === 0
    ? 0
    : results.reduce((sum, result) => sum + result.score.recall, 0) / results.length;
  const regressionMeanPrecision = results.length === 0
    ? 0
    : results.reduce((sum, result) => sum + result.score.precision, 0) / results.length;

  printSectionTitle("Run Summary");
  console.log(
    `Production benchmark quality: ${meanQuality === null ? `${DIM}n/a${RESET}` : colourScore(meanQuality)}`,
  );
  console.log(
    `Regression guardrails: recall ${colourScore(regressionMeanRecall)}, precision ${colourScore(regressionMeanPrecision)}`,
  );
}

function printSectionTitle(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`);
}

function compareResults(left: EvalResult, right: EvalResult): number {
  const leftQuality = left.reviewQuality?.overall ?? Number.POSITIVE_INFINITY;
  const rightQuality = right.reviewQuality?.overall ?? Number.POSITIVE_INFINITY;
  if (leftQuality !== rightQuality) {
    return leftQuality - rightQuality;
  }
  if (left.score.recall !== right.score.recall) {
    return left.score.recall - right.score.recall;
  }
  if (left.score.precision !== right.score.precision) {
    return left.score.precision - right.score.precision;
  }
  return left.fixtureId.localeCompare(right.fixtureId);
}

/**
 * Prints a formatted eval report to stdout.
 *
 * @param results - Evaluation results to display.
 */
export function printReport(results: readonly EvalResult[]): void {
  const orderedResults = [...results].sort(compareResults);
  printRunSummary(orderedResults);
  printSectionTitle("Regression Guardrails");

  const header = `${"Fixture".padEnd(25)} ${"Variant".padEnd(18)} ${"Mode".padEnd(12)} ${"Recall".padEnd(14)} ${"Precision".padEnd(14)} ${"Findings".padEnd(10)} ${"FP".padEnd(6)} ${"Time".padEnd(10)}`;
  console.log(header);
  console.log("─".repeat(118));

  for (const result of orderedResults) {
    const fpDisplay = result.score.falsePositiveCount > 0
      ? `${RED}${result.score.falsePositiveCount}${RESET}`
      : `${DIM}0${RESET}`;
    const line = `${result.fixtureId.padEnd(25)} ${result.variant.padEnd(18)} ${formatExecutionMode(result).padEnd(12 + ANSI_OVERHEAD)} ${colourScore(result.score.recall).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(result.score.precision).padEnd(14 + ANSI_OVERHEAD)} ${String(result.score.totalFindings).padEnd(10)} ${fpDisplay.padEnd(6 + ANSI_OVERHEAD)} ${DIM}${result.durationMs}ms${RESET}`;
    console.log(line);
  }

  const qualityResults = orderedResults.filter((result) => result.reviewQuality !== null);
  if (qualityResults.length > 0) {
    printSectionTitle("Production Quality");
    const qualityHeader = `${"Fixture".padEnd(25)} ${"Variant".padEnd(18)} ${"Overall".padEnd(14)} ${"Coverage".padEnd(14)} ${"Restraint".padEnd(14)} ${"Priority".padEnd(14)}`;
    console.log(qualityHeader);
    console.log("─".repeat(104));

    for (const result of qualityResults) {
      const quality = result.reviewQuality;
      if (!quality) continue;
      const line = `${result.fixtureId.padEnd(25)} ${result.variant.padEnd(18)} ${colourScore(quality.overall).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(quality.heuristics.mustFindCoverage).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(quality.heuristics.restraint).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(quality.heuristics.prioritisation).padEnd(14 + ANSI_OVERHEAD)}`;
      console.log(line);
    }
  }

  for (const result of orderedResults) {
    const { score } = result;

    if (score.recall < 1.0) {
      const missed = result.score.requiredExpectations - result.score.requiredMatched;
      console.log(
        `\n${RED}Regression miss${RESET} [${result.fixtureId}/${result.variant}]: ${missed} of ${score.requiredExpectations} required expectations missing`,
      );
    }

    if (score.unmatchedFindings.length > 0) {
      console.log(
        `\n${YELLOW}Additional findings${RESET} [${result.fixtureId}/${result.variant}]:`,
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

    if (result.reviewQuality) {
      console.log(
        `\n${CYAN}Benchmark diagnosis${RESET} [${result.fixtureId}/${result.variant}]: ${result.reviewQuality.summary}`,
      );
      for (const dimension of result.reviewQuality.dimensions) {
        console.log(
          `  ${dimension.name}: ${colourScore(dimension.score)} ${DIM}${dimension.rationale.slice(0, 120)}${RESET}`,
        );
      }
    }
  }

  console.log();
}

interface MultiRunSummary {
  readonly fixtureId: string;
  readonly variant: string;
  readonly executionMode: string;
  readonly meanRecall: number;
  readonly fullRecallRate: number;
  readonly meanPrecision: number;
  readonly meanQualityOverall: number | null;
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
      executionMode: firstResult.executionMode,
      meanRecall: recallSum / totalRuns,
      fullRecallRate: fullRecallCount / totalRuns,
      meanPrecision: precisionSum / totalRuns,
      meanQualityOverall: results.every((result) => result.reviewQuality !== null)
        ? results.reduce((sum, result) => sum + (result.reviewQuality?.overall ?? 0), 0) / totalRuns
        : null,
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
  printSectionTitle(`Benchmark Report (${allResults.length} runs)`);

  const summaries = summariseRuns(allResults);

  const header = `${"Fixture".padEnd(25)} ${"Variant".padEnd(18)} ${"Mode".padEnd(12)} ${"Mean Recall".padEnd(16)} ${"P(full)".padEnd(14)} ${"Mean Prec.".padEnd(14)} ${"Quality".padEnd(14)} ${"Runs".padEnd(6)}`;
  console.log(header);
  console.log("─".repeat(122));

  for (const summary of summaries) {
    const qualityDisplay = summary.meanQualityOverall === null
      ? `${DIM}n/a${RESET}`
      : colourScore(summary.meanQualityOverall);
    const line = `${summary.fixtureId.padEnd(25)} ${summary.variant.padEnd(18)} ${summary.executionMode.padEnd(12)} ${colourScore(summary.meanRecall).padEnd(16 + ANSI_OVERHEAD)} ${colourScore(summary.fullRecallRate).padEnd(14 + ANSI_OVERHEAD)} ${colourScore(summary.meanPrecision).padEnd(14 + ANSI_OVERHEAD)} ${qualityDisplay.padEnd(14 + ANSI_OVERHEAD)} ${String(summary.runs).padEnd(6)}`;
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
