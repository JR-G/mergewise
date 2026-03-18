import type { FilePath, Finding, RepoFullName } from "@mergewise/shared-types";
import type { CompletionUsage } from "./client";

/**
 * Boolean tags derived from numeric {@link StructuralSignals} for knowledge matching.
 */
export type SignalTag =
  | "has_hooks"
  | "high_hook_count"
  | "has_classes"
  | "high_function_count"
  | "large_function"
  | "high_nesting"
  | "high_param_count"
  | "has_type_assertions"
  | "high_import_count"
  | "large_component";

/**
 * A worked example within a knowledge document showing good and bad code.
 */
export interface KnowledgeExample {
  readonly label: string;
  readonly scenario: string;
  readonly good: string;
  readonly bad: string;
  readonly explanation: string;
}

/**
 * A self-contained knowledge document that can be retrieved and injected
 * into the review prompt based on structural signals and triage classifications.
 */
export interface KnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** Signal tags that indicate this document is relevant. */
  readonly triggerSignals: readonly SignalTag[];
  /** Triage classification strings that indicate relevance. */
  readonly triggerClassifications: readonly string[];
  /** File extensions this document applies to (empty = all). */
  readonly fileExtensions: readonly string[];
  /** Prose content sent to the LLM as review context. */
  readonly content: string;
  readonly examples: readonly KnowledgeExample[];
}

/**
 * Priority assigned to a file by the triage pass.
 */
export type TriagePriority = "high" | "medium" | "low" | "skip";

/**
 * Classification output from the triage pass for a single file.
 */
export interface TriageResult {
  readonly filePath: FilePath;
  readonly classifications: readonly string[];
  readonly priority: TriagePriority;
  readonly reasoning: string;
}

/**
 * A finding that the critic decided to discard, with a reason.
 */
export interface FilteredFinding {
  readonly finding: Finding;
  readonly reason: string;
}

/**
 * Output of the critic pass: kept findings and discarded findings with reasons.
 */
export interface CriticResult {
  readonly findings: readonly Finding[];
  readonly filtered: readonly FilteredFinding[];
}

/**
 * Graph context for a single file from the debt scanner.
 */
export interface FileGraphContext {
  readonly filePath: FilePath;
  readonly callers: readonly FilePath[];
  readonly centrality: number;
  readonly isHotspot: boolean;
}

/**
 * Repository-level review preferences from the learnings store.
 */
export interface ReviewLearnings {
  readonly preferences: readonly string[];
}

/**
 * Optional tools for enriching review context.
 *
 * @remarks
 * When a tool is undefined, the corresponding prompt section is omitted.
 */
export interface ReviewToolkit {
  readonly getCallers?: ((filePath: FilePath) => FileGraphContext) | undefined;
  readonly getRepoLearnings?: ((
    repoName: RepoFullName,
    filePaths: readonly FilePath[],
  ) => ReviewLearnings) | undefined;
}

/**
 * Per-file token usage from the review stage.
 */
export interface FileTokenUsage {
  readonly filePath: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Aggregated token usage across all pipeline stages.
 */
export interface TokenUsageSummary {
  readonly triageUsage: CompletionUsage | undefined;
  readonly reviewUsage: CompletionUsage | undefined;
  readonly criticUsage: CompletionUsage | undefined;
  readonly totalUsage: CompletionUsage | undefined;
  readonly perFileUsage: readonly FileTokenUsage[];
}

/**
 * Configuration for the three-stage review pipeline.
 */
export interface ReviewPipelineConfig {
  readonly triageModel?: string | undefined;
  readonly reviewModel: string;
  readonly criticModel?: string | undefined;
  readonly maxFilesPerReview?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly toolkit?: ReviewToolkit | undefined;
  readonly confidenceThreshold?: number | undefined;
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly maxRetries?: number | undefined;
  readonly agentFriendliness?: boolean | undefined;
}

/**
 * A file that failed during the review stage.
 */
export interface FileReviewFailure {
  readonly filePath: FilePath;
  readonly error: string;
}

/**
 * Full result of a pipeline run including findings and audit trail.
 */
export interface ReviewPipelineResult {
  readonly findings: readonly Finding[];
  readonly triageResults: readonly TriageResult[];
  readonly criticReport: CriticResult;
  readonly tokenUsage: TokenUsageSummary;
  readonly failedFiles: readonly FileReviewFailure[];
}
