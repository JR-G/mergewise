import type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  Finding,
} from "@mergewise/shared-types";
import { createReviewClient, type ReviewClientConfig } from "./client";
import { selectFilesForReview } from "./file-selection";
import { reviewFile } from "./review-file";

export type { AntiPattern } from "./anti-patterns";
export { ANTI_PATTERNS } from "./anti-patterns";
export type { ReviewClientConfig, CompletionUsage, CompletionResult } from "./client";
export type { FileReviewResult } from "./review-file";
export { selectFilesForReview } from "./file-selection";
export { buildSystemPrompt, buildFileReviewPrompt } from "./prompt";
export { parseLlmResponse, extractAddedLineNumbers, extractAddedLineMap, deduplicateByProximity, isCommentLine, isPlausibleRewrite } from "./schema";
export type { AddedLineInfo } from "./schema";
export { extractStructuralSignals, type StructuralSignals } from "./signals";
export { reviewFile } from "./review-file";
export { createReviewClient, ReviewClient } from "./client";
export { applyConsensusFilter, extractWordTokens, jaccardSimilarity } from "./consensus";

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
  const confidenceThreshold = config.confidenceThreshold;
  const consistencySamples = config.consistencySamples;
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

      const allFindings: Finding[] = [];

      for (const fileDiff of selectedFiles) {
        try {
          const result = await reviewFile({
            fileDiff,
            pullRequest: context.pullRequest,
            codebaseContext,
            client,
            confidenceThreshold,
            consistencySamples,
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
    },
  };
}
