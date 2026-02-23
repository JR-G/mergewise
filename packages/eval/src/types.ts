import type {
  FileDiff,
  Finding,
  FindingCategory,
} from "@mergewise/shared-types";
import type { AntiPattern } from "@mergewise/llm-reviewer";
import type { ReviewClientConfig } from "@mergewise/llm-reviewer";

export interface ExpectedFinding {
  readonly description: string;
  readonly matchLineRange?: readonly [number, number];
  readonly matchCategory?: FindingCategory;
  readonly matchEvidenceContains?: string;
  readonly matchRecommendationContains?: string;
  readonly required: boolean;
}

export interface EvalFixture {
  readonly fixtureId: string;
  readonly fileDiff: FileDiff;
  readonly fullFileContent: string | null;
  readonly expectations: readonly ExpectedFinding[];
}

export interface EvalVariant {
  readonly label: string;
  readonly clientConfig: ReviewClientConfig;
  readonly antiPatterns?: readonly AntiPattern[];
}

export interface EvalScore {
  readonly requiredExpectations: number;
  readonly requiredMatched: number;
  readonly recall: number;
  readonly totalFindings: number;
  readonly matchedFindings: number;
  readonly precision: number;
  readonly unmatchedFindings: readonly Finding[];
}

export interface EvalResult {
  readonly fixtureId: string;
  readonly variant: string;
  readonly score: EvalScore;
  readonly findings: readonly Finding[];
  readonly durationMs: number;
}

export interface RunRecord {
  readonly timestamp: string;
  readonly results: readonly EvalResult[];
}
