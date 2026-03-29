import type {
  FileDiff,
  Finding,
  FindingCategory,
  PullRequestMetadata,
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
  /** OR-logic alternative: passes if any keyword appears in the recommendation (case-insensitive). */
  readonly matchRecommendationContainsAny?: readonly string[];
  /** When true, this expectation counts towards recall. */
  readonly required: boolean;
  /** When true, a matching finding is a false positive. Mutually exclusive with required. */
  readonly forbidden?: boolean;
}

/**
 * Runtime used to execute a fixture.
 */
export type EvalExecutionMode = "legacy" | "pipeline";

/**
 * Optional quality rubric describing reviewer expectations beyond keyword matches.
 */
export interface ReviewQualityRubric {
  /** Short scenario summary shown to the judge. */
  readonly summary: string;
  /** What a strong reviewer should optimise for in this scenario. */
  readonly reviewGoal: string;
  /** Required issues a high-quality reviewer should surface. */
  readonly mustFind: readonly ExpectedFinding[];
  /** Issues a high-quality reviewer should avoid surfacing. */
  readonly mustAvoid: readonly ExpectedFinding[];
  /** Acceptable range for the number of findings posted. */
  readonly findingCountRange?: readonly [number, number];
  /** Optional expectation that should appear among the highest-priority comments. */
  readonly prioritise?: readonly ExpectedFinding[];
  /** Reviewer-quality dimensions to score with an LLM judge. */
  readonly dimensions?: readonly ReviewQualityDimension[];
}

/**
 * One named reviewer-quality dimension scored by the judge.
 */
export interface ReviewQualityDimension {
  readonly name: string;
  readonly description: string;
  /** Relative importance. Defaults to 1 when omitted by fixture authors. */
  readonly weight?: number;
}

/**
 * Optional per-fixture execution configuration.
 */
export interface EvalFixtureConfig {
  readonly executionMode?: EvalExecutionMode;
  readonly prTitle?: string;
  readonly prDescription?: string;
  readonly maxFilesPerReview?: number;
  readonly reviewQuality?: ReviewQualityRubric;
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
  /** Additional source files available to pipeline-mode fixtures. */
  readonly sourceFiles: ReadonlyMap<string, string>;
  /** Expected findings to score against. */
  readonly expectations: readonly ExpectedFinding[];
  /** Execution and review-quality metadata. */
  readonly config: EvalFixtureConfig;
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
  /** Confidence threshold override for prompt guidance. Undefined uses the default. */
  readonly confidenceThreshold?: number;
  /** Optional judge model used for reviewer-quality scoring. */
  readonly judgeModel?: string;
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
  /** Findings that matched a forbidden expectation. */
  readonly falsePositiveCount: number;
}

/**
 * Heuristic reviewer-quality metrics derived without an LLM judge.
 */
export interface ReviewQualityHeuristics {
  readonly mustFindCoverage: number;
  readonly restraint: number;
  readonly prioritisation: number;
}

/**
 * One scored reviewer-quality dimension from the judge.
 */
export interface ReviewQualityDimensionScore {
  readonly name: string;
  /** Value from 0 to 1 inclusive. */
  readonly score: number;
  readonly rationale: string;
}

/**
 * Reviewer-quality assessment for a fixture run.
 */
export interface ReviewQualityScore {
  readonly overall: number;
  readonly heuristics: ReviewQualityHeuristics;
  readonly dimensions: readonly ReviewQualityDimensionScore[];
  readonly summary: string;
  readonly scoringMode: "heuristic" | "judge";
}

/**
 * Full result of evaluating one fixture against one variant.
 */
export interface EvalResult {
  readonly fixtureId: string;
  readonly variant: string;
  readonly executionMode: EvalExecutionMode;
  readonly score: EvalScore;
  readonly findings: readonly Finding[];
  readonly reviewQuality: ReviewQualityScore | null;
  /** Wall-clock milliseconds for the LLM call. */
  readonly durationMs: number;
}

/**
 * Options controlling fixture execution for one eval run.
 */
export interface EvalRunOptions {
  readonly executionMode?: EvalExecutionMode;
  readonly judgeClientConfig?: ReviewClientConfig;
}

/**
 * Loaded execution context used by both legacy and pipeline runners.
 */
export interface EvalExecutionInput {
  readonly fixture: EvalFixture;
  readonly pullRequest: PullRequestMetadata;
  readonly codebaseContextReadFile: (relativePath: string) => Promise<string | null>;
}

/**
 * A timestamped record of one complete eval run, persisted as NDJSON.
 */
export interface RunRecord {
  /** ISO 8601 timestamp of the run. */
  readonly timestamp: string;
  readonly results: readonly EvalResult[];
}
