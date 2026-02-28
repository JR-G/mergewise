import type {
  CodebaseContext,
  FileDiff,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import { ANTI_PATTERNS } from "./anti-patterns";
import type { ReviewClient } from "./client";
import { buildFileReviewPrompt, buildSystemPrompt } from "./prompt";
import { parseLlmResponse } from "./schema";
import { extractStructuralSignals } from "./signals";

const MAX_RESPONSE_TOKENS = 4096;

export interface ReviewFileOptions {
  readonly fileDiff: FileDiff;
  readonly pullRequest: PullRequestMetadata;
  readonly codebaseContext: CodebaseContext;
  readonly client: ReviewClient;
}

/**
 * Reviews a single file diff using the LLM and returns validated findings.
 *
 * @param options - Review file configuration.
 * @returns Findings from the LLM review, validated against the diff.
 */
export async function reviewFile(options: ReviewFileOptions): Promise<Finding[]> {
  const { fileDiff, pullRequest, codebaseContext, client } = options;
  const fullContent = await codebaseContext.readFile(fileDiff.filePath);
  const signals = extractStructuralSignals(fileDiff);

  const systemPrompt = buildSystemPrompt(ANTI_PATTERNS);
  const userPrompt = buildFileReviewPrompt(fileDiff, fullContent, signals);

  const rawResponse = await client.complete(
    systemPrompt,
    userPrompt,
    MAX_RESPONSE_TOKENS,
  );

  return parseLlmResponse(rawResponse, fileDiff, pullRequest);
}
