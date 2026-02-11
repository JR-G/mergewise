/**
 * Finding categories aligned with Mergewise review focus areas.
 */
export type FindingCategory = "clean" | "perf" | "safety" | "idiomatic";

/**
 * Lifecycle status of a posted finding.
 */
export type FindingStatus = "posted" | "dismissed" | "accepted" | "resolved";

/**
 * Structured diff patch preview for agent and tool consumption.
 */
export interface PatchPreview {
  /** Lines removed by the suggested patch. */
  readonly removedLines: readonly string[];
  /** Lines added by the suggested patch. */
  readonly addedLines: readonly string[];
  /** Unified diff hunk header (e.g. `@@ -10,5 +10,7 @@`). */
  readonly hunkHeader: string;
}

/**
 * A single review finding produced by a rule against a pull request.
 *
 * @remarks
 * Maps directly to the core finding schema defined in ARCHITECTURE_V0.md.
 * All fields are readonly to enforce immutability through the analysis pipeline.
 */
export interface Finding {
  /** Stable unique identifier for this finding. */
  readonly findingId: string;
  /** GitHub App installation identifier for API token resolution. */
  readonly installationId: number | null;
  /** Repository full name in `owner/name` format. */
  readonly repo: string;
  /** Pull request number in the target repository. */
  readonly prNumber: number;
  /** Source language of the analysed file. */
  readonly language: string;
  /** Identifier of the rule that produced this finding. */
  readonly ruleId: string;
  /** Review focus category. */
  readonly category: FindingCategory;
  /** Path to the file containing the finding, relative to repo root. */
  readonly filePath: string;
  /** One-indexed line number where the finding applies. */
  readonly line: number;
  /** Code evidence supporting the finding. */
  readonly evidence: string;
  /** Actionable recommendation describing the suggested change. */
  readonly recommendation: string;
  /** Optional structured patch preview for inline suggestions. */
  readonly patchPreview?: PatchPreview;
  /** Confidence score between 0 and 1 inclusive. */
  readonly confidence: number;
  /** Current lifecycle status of the finding. */
  readonly status: FindingStatus;
}
