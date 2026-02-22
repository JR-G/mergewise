import type {
  CodebaseContext,
  FileDiff,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import type { ReviewClient } from "./client";
import { buildFileReviewPrompt, buildSystemPrompt } from "./prompt";
import { parseLlmResponse } from "./schema";
import { extractStructuralSignals } from "./signals";

const MAX_RESPONSE_TOKENS = 4096;

/**
 * Reviews a single file diff using the LLM and returns validated findings.
 *
 * @param fileDiff - Parsed diff for the file under review.
 * @param pullRequest - PR metadata for finding attribution.
 * @param codebaseContext - Repository context for fetching full file content.
 * @param client - Configured LLM client.
 * @returns Findings from the LLM review, validated against the diff.
 */
export async function reviewFile(
  fileDiff: FileDiff,
  pullRequest: PullRequestMetadata,
  codebaseContext: CodebaseContext,
  client: ReviewClient,
): Promise<Finding[]> {
  const fullContent = await codebaseContext.readFile(fileDiff.filePath);
  const signals = extractStructuralSignals(fileDiff);

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildFileReviewPrompt(fileDiff, fullContent, signals);

  const rawResponse = await client.complete(
    systemPrompt,
    userPrompt,
    MAX_RESPONSE_TOKENS,
  );

  return parseLlmResponse(rawResponse, fileDiff, pullRequest);
}
