import type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  FileDiff,
  Finding,
} from "@mergewise/shared-types";
import { toRuleId } from "@mergewise/shared-types";
import type { ReviewClientConfig } from "./client";
import { selectFilesForReview } from "./file-selection";
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
export { createReviewClient, ReviewClient, mergeUsage } from "./client";
export { applyConsensusFilter, extractWordTokens, jaccardSimilarity } from "./consensus";

export { runReviewPipeline } from "./pipeline";
export { triageFiles } from "./triage";
export { criticFindings } from "./critic";
export { retrieveKnowledge } from "./knowledge/retrieve";
export { deriveSignalTags } from "./knowledge/signal-tags";
export { buildSlimSystemPrompt, buildDynamicFilePrompt, buildToolUseFilePrompt } from "./prompt-slim";
export type { ToolUsePromptInput } from "./prompt-slim";
export { REVIEW_TOOLS, toOpenAiTools, executeToolCall, buildAvailablePatternsSummary } from "./review-tools";
export type { ReviewTool, ToolContext } from "./review-tools";
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
  FileReviewFailure,
  ReviewPipelineConfig,
  ReviewPipelineResult,
  ReviewToolkit,
  FileGraphContext,
  ReviewLearnings,
  TokenUsageSummary,
} from "./pipeline-types";

const DEFAULT_TOKEN_BUDGET = 30_000;

/**
 * Configuration for the LLM reviewer rule.
 */
export interface LlmReviewerConfig {
  readonly clientConfig: ReviewClientConfig;
  readonly tokenBudget?: number | undefined;
  /**
   * Glob patterns for files to exclude from LLM review.
   *
   * @remarks
   * Matched against file paths alongside built-in skip patterns.
   * When omitted, only built-in patterns apply.
   */
  readonly userSkipPatterns?: readonly string[] | undefined;
  readonly confidenceThreshold?: number | undefined;
  /**
   * Model identifier for the triage and critic stages.
   *
   * @remarks
   * Should be a fast, cheap model.
   */
  readonly triageModel?: string | undefined;
  /**
   * Model identifier for the critic stage.
   *
   * @remarks
   * Defaults to `triageModel` if omitted.
   */
  readonly criticModel?: string | undefined;
  /**
   * Optional tools for enriching review context (graph, learnings).
   */
  readonly toolkit?: ReviewToolkit | undefined;
  /**
   * When enabled, the review prompt gains agent-specific detection criteria
   * and frames suggestions with AI agent impact reasoning.
   */
  readonly agentFriendliness?: boolean | undefined;
  readonly onFileReviewError?: ((filePath: string, error: unknown) => void) | undefined;
  readonly onFileReviewComplete?: ((filePath: string, findingCount: number, promptTokens: number, completionTokens: number) => void) | undefined;
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
  const tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const userSkipPatterns = config.userSkipPatterns;

  return {
    kind: "codebase-aware",
    metadata: {
      ruleId: toRuleId("llm/reviewer"),
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

      return analysePipeline(config, selectedFiles, context, codebaseContext);
    },
  };
}

async function analysePipeline(
  config: LlmReviewerConfig,
  selectedFiles: readonly FileDiff[],
  context: AnalysisContext,
  codebaseContext: CodebaseContext,
): Promise<readonly Finding[]> {
  const onError = config.onFileReviewError;
  const onComplete = config.onFileReviewComplete;

  try {
    const result = await runReviewPipeline(selectedFiles, context.pullRequest, codebaseContext, {
      triageModel: config.triageModel,
      reviewModel: config.clientConfig.model ?? "gpt-4.1",
      criticModel: config.criticModel,
      tokenBudget: config.tokenBudget,
      toolkit: config.toolkit,
      confidenceThreshold: config.confidenceThreshold,
      apiKey: config.clientConfig.apiKey,
      baseUrl: config.clientConfig.baseUrl,
      maxRetries: config.clientConfig.maxRetries,
      agentFriendliness: config.agentFriendliness,
    });

    if (onError) {
      for (const failure of result.failedFiles) {
        onError(failure.filePath, new Error(failure.error));
      }
    }

    if (onComplete) {
      const failedPaths = new Set(result.failedFiles.map((failure) => failure.filePath));
      let tokenUsageReported = false;
      for (const file of selectedFiles) {
        if (failedPaths.has(file.filePath)) continue;
        const count = result.findings.filter((finding) => finding.filePath === file.filePath).length;
        if (!tokenUsageReported && result.tokenUsage.totalUsage) {
          onComplete(
            file.filePath,
            count,
            result.tokenUsage.totalUsage.promptTokens,
            result.tokenUsage.totalUsage.completionTokens,
          );
          tokenUsageReported = true;
        } else {
          onComplete(file.filePath, count, 0, 0);
        }
      }
    }

    return result.findings;
  } catch (error) {
    if (onError) {
      for (const file of selectedFiles) {
        onError(file.filePath, error);
      }
    }
    return [];
  }
}

