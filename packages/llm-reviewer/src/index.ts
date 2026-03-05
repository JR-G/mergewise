import type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  Finding,
} from "@mergewise/shared-types";
import { createReviewClient, type ReviewClientConfig } from "./client";
import { selectFilesForReview } from "./file-selection";
import { reviewFile } from "./review-file";
import { runReviewPipeline } from "./pipeline";
import type { ReviewToolkit } from "./pipeline-types";

export type { AntiPattern } from "./anti-patterns";
export { ANTI_PATTERNS } from "./anti-patterns";
export type { ReviewClientConfig, CompletionUsage, CompletionResult } from "./client";
export type { FileReviewResult } from "./review-file";
export { selectFilesForReview } from "./file-selection";
export { buildSystemPrompt, buildFileReviewPrompt } from "./prompt";
export { parseLlmResponse, extractAddedLineNumbers, extractAddedLineMap, deduplicateByProximity, isCommentLine, isPlausibleRewrite, sanitiseSuggestedRewrite, hasEvidenceLineOverlap } from "./schema";
export type { AddedLineInfo, RawLlmFinding } from "./schema";
export { extractStructuralSignals, type StructuralSignals } from "./signals";
export { reviewFile } from "./review-file";
export { createReviewClient, ReviewClient } from "./client";
export { applyConsensusFilter, extractWordTokens, jaccardSimilarity } from "./consensus";

export { runReviewPipeline } from "./pipeline";
export { triageFiles } from "./triage";
export { criticFindings } from "./critic";
export { retrieveKnowledge } from "./knowledge/retrieve";
export { deriveSignalTags } from "./knowledge/signal-tags";
export { buildSlimSystemPrompt, buildDynamicFilePrompt } from "./prompt-slim";
export { formatKnowledgeSection } from "./knowledge/format";
export { KNOWLEDGE_REGISTRY } from "./knowledge/registry";

export type {
  KnowledgeDocument,
  KnowledgeExample,
  SignalTag,
  TriageResult,
  TriagePriority,
  CriticResult,
  FilteredFinding,
  ReviewPipelineConfig,
  ReviewPipelineResult,
  ReviewToolkit,
  FileGraphContext,
  ReviewLearnings,
  TokenUsageSummary,
} from "./pipeline-types";

const DEFAULT_TOKEN_BUDGET = 30_000;

function noop(): void {
  /* intentional no-op */
}

/**
 * Configuration for the LLM reviewer rule.
 */
export interface LlmReviewerConfig {
  readonly clientConfig: ReviewClientConfig;
  readonly tokenBudget?: number;
  /**
   * Glob patterns for files to exclude from LLM review.
   *
   * @remarks
   * Matched against file paths alongside built-in skip patterns.
   * When omitted, only built-in patterns apply.
   */
  readonly userSkipPatterns?: readonly string[];
  readonly confidenceThreshold?: number;
  /**
   * Number of independent LLM samples for self-consistency filtering.
   *
   * @remarks
   * When greater than 1, each file is reviewed N times with elevated
   * temperature and only findings appearing in the majority of runs
   * are kept. Defaults to 1 (single-shot).
   */
  readonly consistencySamples?: number;
  /**
   * When true, uses the three-stage pipeline (triage → review → critic)
   * instead of the single-shot per-file review.
   */
  readonly usePipeline?: boolean;
  /**
   * Model identifier for the triage and critic stages.
   *
   * @remarks
   * Should be a fast, cheap model. Only used when `usePipeline` is true.
   */
  readonly triageModel?: string;
  /**
   * Model identifier for the critic stage.
   *
   * @remarks
   * Defaults to `triageModel` if omitted. Only used when `usePipeline` is true.
   */
  readonly criticModel?: string;
  /**
   * Optional tools for enriching review context (graph, learnings).
   *
   * @remarks
   * Only used when `usePipeline` is true.
   */
  readonly toolkit?: ReviewToolkit;
  readonly onFileReviewError?: (filePath: string, error: unknown) => void;
  readonly onFileReviewComplete?: (filePath: string, findingCount: number, promptTokens: number, completionTokens: number) => void;
}

/**
 * Creates an LLM reviewer rule that analyses file diffs using an
 * OpenAI-compatible API.
 *
 * @remarks
 * Returns a `CodebaseAwareRule` that integrates with the existing rule
 * engine. Files are selected by priority (change volume, file type),
 * filtered against skip patterns, and reviewed within a token budget.
 * Each file is reviewed independently with structural signals for context.
 *
 * @param config - LLM client and review configuration.
 * @returns A codebase-aware rule for the rule engine.
 */
export function createLlmReviewerRule(
  config: LlmReviewerConfig,
): CodebaseAwareRule {
  const client = createReviewClient(config.clientConfig);
  const tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const userSkipPatterns = config.userSkipPatterns;
  const onFileReviewError = config.onFileReviewError ?? noop;

  return {
    kind: "codebase-aware",
    metadata: {
      ruleId: "llm/reviewer",
      name: "LLM Reviewer",
      category: "idiomatic",
      languages: ["typescript"],
      description:
        "AI-powered review for naming, responsibility separation, SOLID/DRY/KISS violations, and idiomatic patterns.",
    },
    analyse: async (
      context: AnalysisContext,
      codebaseContext: CodebaseContext,
    ): Promise<readonly Finding[]> => {
      const selectedFiles = selectFilesForReview(context.diffs, tokenBudget, userSkipPatterns);

      if (selectedFiles.length === 0) {
        return [];
      }

      if (config.usePipeline) {
        return analysePipeline(config, selectedFiles, context, codebaseContext);
      }

      return analysePerFile({ selectedFiles, context, codebaseContext, client, config, onFileReviewError });
    },
  };
}

async function analysePipeline(
  config: LlmReviewerConfig,
  selectedFiles: readonly import("@mergewise/shared-types").FileDiff[],
  context: AnalysisContext,
  codebaseContext: CodebaseContext,
): Promise<readonly Finding[]> {
  const result = await runReviewPipeline(selectedFiles, context.pullRequest, codebaseContext, {
    triageModel: config.triageModel,
    reviewModel: config.clientConfig.model ?? "gpt-4o",
    criticModel: config.criticModel,
    tokenBudget: config.tokenBudget,
    toolkit: config.toolkit,
    confidenceThreshold: config.confidenceThreshold,
    apiKey: config.clientConfig.apiKey,
    baseUrl: config.clientConfig.baseUrl,
  });
  return result.findings;
}

interface PerFileAnalysisOptions {
  readonly selectedFiles: readonly import("@mergewise/shared-types").FileDiff[];
  readonly context: AnalysisContext;
  readonly codebaseContext: CodebaseContext;
  readonly client: import("./client").ReviewClient;
  readonly config: LlmReviewerConfig;
  readonly onFileReviewError: (filePath: string, error: unknown) => void;
}

async function analysePerFile(options: PerFileAnalysisOptions): Promise<readonly Finding[]> {
  const { selectedFiles, context, codebaseContext, client, config, onFileReviewError } = options;
  const allFindings: Finding[] = [];

  for (const fileDiff of selectedFiles) {
    try {
      const result = await reviewFile({
        fileDiff,
        pullRequest: context.pullRequest,
        codebaseContext,
        client,
        confidenceThreshold: config.confidenceThreshold,
        consistencySamples: config.consistencySamples,
      });
      allFindings.push(...result.findings);
      config.onFileReviewComplete?.(
        fileDiff.filePath,
        result.findings.length,
        result.usage?.promptTokens ?? 0,
        result.usage?.completionTokens ?? 0,
      );
    } catch (error) {
      onFileReviewError(fileDiff.filePath, error);
      continue;
    }
  }

  return allFindings;
}
