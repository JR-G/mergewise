import type {
  FileDiff,
  Finding,
  FindingCategory,
} from "@mergewise/shared-types";
import type { AntiPattern, ReviewClientConfig } from "@mergewise/llm-reviewer";

/**
 * A single expected finding against which LLM output is scored.
 *
 * @remarks
 * All `match*` fields are AND-ed — a finding must satisfy every specified
 * field to count as a match. Omitted fields are not checked.
 */
export interface ExpectedFinding {
  /** Human-readable label for this expectation. */
  readonly description: string;
  /** Inclusive line range the finding must fall within. */
  readonly matchLineRange?: readonly [number, number];
  /** Required finding category. */
  readonly matchCategory?: FindingCategory;
  /** Case-insensitive substring that must appear in the finding evidence. */
  readonly matchEvidenceContains?: string;
  /** Case-insensitive substring that must appear in the finding recommendation. */
  readonly matchRecommendationContains?: string;
  /** When true, this expectation counts towards recall. */
  readonly required: boolean;
}

/**
 * A loaded fixture ready for evaluation.
 */
export interface EvalFixture {
  /** Directory name used as the fixture identifier. */
  readonly fixtureId: string;
  /** Parsed diff to send to the reviewer. */
  readonly fileDiff: FileDiff;
  /** Full file content for context, or null if unavailable. */
  readonly fullFileContent: string | null;
  /** Expected findings to score against. */
  readonly expectations: readonly ExpectedFinding[];
}

/**
 * A named configuration variant for an eval run.
 */
export interface EvalVariant {
  /** Display label (e.g. "default", "no-catalogue"). */
  readonly label: string;
  /** LLM client configuration. */
  readonly clientConfig: ReviewClientConfig;
  /** Anti-pattern catalogue override. Undefined uses the default catalogue. */
  readonly antiPatterns?: readonly AntiPattern[];
}

/**
 * Scoring result for a single fixture/variant combination.
 */
export interface EvalScore {
  /** Total number of required expectations. */
  readonly requiredExpectations: number;
  /** How many required expectations were matched. */
  readonly requiredMatched: number;
  /** Fraction of required expectations matched (1.0 if none required). */
  readonly recall: number;
  /** Total findings produced by the LLM. */
  readonly totalFindings: number;
  /** Findings that matched any expectation. */
  readonly matchedFindings: number;
  /** Fraction of findings that matched (1.0 if no findings). */
  readonly precision: number;
  /** Findings that did not match any expectation. */
  readonly unmatchedFindings: readonly Finding[];
}

/**
 * Full result of evaluating one fixture against one variant.
 */
export interface EvalResult {
  readonly fixtureId: string;
  readonly variant: string;
  readonly score: EvalScore;
  readonly findings: readonly Finding[];
  /** Wall-clock milliseconds for the LLM call. */
  readonly durationMs: number;
}

/**
 * A timestamped record of one complete eval run, persisted as NDJSON.
 */
export interface RunRecord {
  /** ISO 8601 timestamp of the run. */
  readonly timestamp: string;
  readonly results: readonly EvalResult[];
}
