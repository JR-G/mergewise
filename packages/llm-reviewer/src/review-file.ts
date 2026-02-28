import type {
  CodebaseContext,
  FileDiff,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import { ANTI_PATTERNS } from "./anti-patterns";
import type { CompletionUsage, ReviewClient } from "./client";
import { buildFileReviewPrompt, buildSystemPrompt } from "./prompt";
import { parseLlmResponse } from "./schema";
import { extractStructuralSignals } from "./signals";

const MAX_RESPONSE_TOKENS = 4096;

export interface ReviewFileOptions {
  readonly fileDiff: FileDiff;
  readonly pullRequest: PullRequestMetadata;
  readonly codebaseContext: CodebaseContext;
  readonly client: ReviewClient;
  readonly confidenceThreshold?: number;
}

/**
 * Result of reviewing a single file, including findings and token usage.
 */
export interface FileReviewResult {
  readonly findings: Finding[];
  readonly usage: CompletionUsage | undefined;
}

/**
 * Reviews a single file diff using the LLM and returns validated findings.
 *
 * @param options - Review file configuration.
 * @returns Findings and token usage from the LLM review.
 */
export async function reviewFile(options: ReviewFileOptions): Promise<FileReviewResult> {
  const { fileDiff, pullRequest, codebaseContext, client } = options;
  const fullContent = await codebaseContext.readFile(fileDiff.filePath);
  const signals = extractStructuralSignals(fileDiff);

  const systemPrompt = buildSystemPrompt(ANTI_PATTERNS, options.confidenceThreshold);
  const userPrompt = buildFileReviewPrompt(fileDiff, fullContent, signals);

  const { content, usage } = await client.complete(
    systemPrompt,
    userPrompt,
    MAX_RESPONSE_TOKENS,
  );

  const findings = parseLlmResponse(content, fileDiff, pullRequest);
  return { findings, usage };
}
