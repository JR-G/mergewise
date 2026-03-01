import type {
  CodebaseContext,
  FileDiff,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import { ANTI_PATTERNS } from "./anti-patterns";
import type { CompletionUsage, ReviewClient } from "./client";
import { applyConsensusFilter } from "./consensus";
import { buildFileReviewPrompt, buildSystemPrompt } from "./prompt";
import { parseLlmResponse } from "./schema";
import { extractStructuralSignals } from "./signals";

const MAX_RESPONSE_TOKENS = 4096;
const CONSISTENCY_TEMPERATURE = 0.5;

export interface ReviewFileOptions {
  readonly fileDiff: FileDiff;
  readonly pullRequest: PullRequestMetadata;
  readonly codebaseContext: CodebaseContext;
  readonly client: ReviewClient;
  readonly confidenceThreshold?: number;
  /**
   * Number of independent LLM samples to run for self-consistency filtering.
   *
   * @remarks
   * When greater than 1, each sample uses a higher temperature (0.5) and
   * only findings that appear consistently across the majority of runs
   * are kept. Defaults to 1 (single-shot, current behaviour).
   */
  readonly consistencySamples?: number;
}

/**
 * Result of reviewing a single file, including findings and token usage.
 */
export interface FileReviewResult {
  readonly findings: Finding[];
  readonly usage: CompletionUsage | undefined;
}

interface SingleReviewOptions {
  readonly client: ReviewClient;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly fileDiff: FileDiff;
  readonly pullRequest: PullRequestMetadata;
  readonly temperature?: number;
}

/**
 * Runs a single LLM review pass and returns parsed findings with usage.
 */
async function runSingleReview(
  options: SingleReviewOptions,
): Promise<{ findings: Finding[]; usage: CompletionUsage | undefined }> {
  const { content, usage } = await options.client.complete(
    options.systemPrompt,
    options.userPrompt,
    MAX_RESPONSE_TOKENS,
    options.temperature,
  );
  const findings = parseLlmResponse(content, options.fileDiff, options.pullRequest);
  return { findings, usage };
}

/**
 * Merges token usage from multiple LLM runs into a single aggregate.
 */
function mergeUsage(
  usages: readonly (CompletionUsage | undefined)[],
): CompletionUsage | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let hasAny = false;

  for (const usage of usages) {
    if (!usage) continue;
    hasAny = true;
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    totalTokens += usage.totalTokens;
  }

  return hasAny ? { promptTokens, completionTokens, totalTokens } : undefined;
}

/**
 * Reviews a single file diff using the LLM and returns validated findings.
 *
 * @remarks
 * When `consistencySamples` is greater than 1, the LLM is called N times
 * with elevated temperature and only findings that appear in the majority
 * of runs survive the consensus filter.
 *
 * @param options - Review file configuration.
 * @returns Findings and token usage from the LLM review.
 */
export async function reviewFile(options: ReviewFileOptions): Promise<FileReviewResult> {
  const { fileDiff, pullRequest, codebaseContext, client } = options;
  const consistencySamples = options.consistencySamples ?? 1;

  const fullContent = await codebaseContext.readFile(fileDiff.filePath);
  const signals = extractStructuralSignals(fileDiff);
  const systemPrompt = buildSystemPrompt(ANTI_PATTERNS, options.confidenceThreshold);
  const userPrompt = buildFileReviewPrompt(fileDiff, fullContent, signals);

  if (consistencySamples <= 1) {
    const { content, usage } = await client.complete(
      systemPrompt,
      userPrompt,
      MAX_RESPONSE_TOKENS,
    );
    const findings = parseLlmResponse(content, fileDiff, pullRequest);
    return { findings, usage };
  }

  const samplePromises = Array.from({ length: consistencySamples }, () =>
    runSingleReview({
      client,
      systemPrompt,
      userPrompt,
      fileDiff,
      pullRequest,
      temperature: CONSISTENCY_TEMPERATURE,
    }),
  );

  const results = await Promise.all(samplePromises);
  const findingSets = results.map((result) => result.findings);
  const usages = results.map((result) => result.usage);

  const consensusFindings = applyConsensusFilter(findingSets);
  return { findings: consensusFindings, usage: mergeUsage(usages) };
}
