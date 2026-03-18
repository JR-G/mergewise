import type {
  CodebaseContext,
  FileDiff,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import { createReviewClient, mergeUsage, type CompletionUsage, type ReviewClient } from "./client";
import type {
  CriticResult,
  FileReviewFailure,
  ReviewPipelineConfig,
  ReviewPipelineResult,
  TokenUsageSummary,
  TriageResult,
} from "./pipeline-types";
import { triageFiles } from "./triage";
import { criticFindings, collectFileContents } from "./critic";
import { extractStructuralSignals } from "./signals";
import { buildSlimSystemPrompt, buildToolUseFilePrompt } from "./prompt-slim";
import { parseLlmResponse } from "./schema";
import { REVIEW_TOOLS, toOpenAiTools, executeToolCall, buildAvailablePatternsSummary } from "./review-tools";
import type { ToolContext } from "./review-tools";

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  skip: 3,
};

const DEFAULT_MAX_FILES = 20;
const MAX_REVIEW_RESPONSE_TOKENS = 4096;
const TOOL_TOKEN_BUDGET = 15_000;

interface PipelineClients {
  readonly triageClient: ReviewClient;
  readonly reviewClient: ReviewClient;
  readonly criticClient: ReviewClient;
}

/**
 * Creates separate client instances for each pipeline stage.
 */
function createPipelineClients(config: ReviewPipelineConfig): PipelineClients {
  const baseConfig = { apiKey: config.apiKey, baseUrl: config.baseUrl, maxRetries: config.maxRetries };

  return {
    triageClient: createReviewClient({ ...baseConfig, model: config.triageModel ?? "gpt-4.1-mini" }),
    reviewClient: createReviewClient({ ...baseConfig, model: config.reviewModel }),
    criticClient: createReviewClient({ ...baseConfig, model: config.criticModel ?? config.triageModel ?? "gpt-4.1-mini" }),
  };
}

/**
 * Builds the aggregated token usage summary for all pipeline stages.
 */
function buildTokenUsage(
  triageUsage: CompletionUsage | undefined,
  reviewUsage: CompletionUsage | undefined,
  criticUsage: CompletionUsage | undefined,
): TokenUsageSummary {
  const totalUsage = mergeUsage(mergeUsage(triageUsage, reviewUsage), criticUsage);
  return { triageUsage, reviewUsage, criticUsage, totalUsage };
}

/**
 * Triage stage with graceful degradation.
 */
async function runTriageStage(
  diffs: readonly FileDiff[],
  client: ReviewClient,
): Promise<{ results: readonly TriageResult[]; usage: CompletionUsage | undefined }> {
  try {
    return await triageFiles(diffs, client);
  } catch {
    const fallbackResults: TriageResult[] = diffs.map((diff) => ({
      filePath: diff.filePath,
      classifications: [],
      priority: "high" as const,
      reasoning: "Triage unavailable — defaulting to high priority",
    }));
    return { results: fallbackResults, usage: undefined };
  }
}

/**
 * Filters and reorders diffs based on triage results.
 */
function selectAndPrioritise(
  diffs: readonly FileDiff[],
  triageResults: readonly TriageResult[],
  maxFiles: number,
): FileDiff[] {
  const triageMap = new Map(triageResults.map((result) => [result.filePath, result]));

  const candidates = diffs.filter((diff) =>
    triageMap.get(diff.filePath)?.priority !== "skip",
  );

  const sorted = [...candidates].sort((left, right) => {
    const leftPriority = triageMap.get(left.filePath)?.priority ?? "medium";
    const rightPriority = triageMap.get(right.filePath)?.priority ?? "medium";
    return (PRIORITY_ORDER[leftPriority] ?? 1) - (PRIORITY_ORDER[rightPriority] ?? 1);
  });

  return sorted.slice(0, maxFiles);
}

interface ReviewStageInput {
  readonly diffs: readonly FileDiff[];
  readonly pullRequest: PullRequestMetadata;
  readonly codebaseContext: CodebaseContext;
  readonly client: ReviewClient;
  readonly config: ReviewPipelineConfig;
}

/**
 * Review stage: per-file review with retrieved knowledge context.
 */
async function runReviewStage(
  input: ReviewStageInput,
): Promise<{ findings: Finding[]; failedFiles: FileReviewFailure[]; usage: CompletionUsage | undefined }> {
  const { diffs, pullRequest, codebaseContext, client, config } = input;
  const systemPrompt = buildSlimSystemPrompt({ agentFriendliness: config.agentFriendliness, toolUse: true });
  const openAiTools = toOpenAiTools(REVIEW_TOOLS);
  const availablePatterns = buildAvailablePatternsSummary();
  const allFindings: Finding[] = [];
  const failedFiles: FileReviewFailure[] = [];
  let combinedUsage: CompletionUsage | undefined;

  for (const diff of diffs) {
    try {
      const fullContent = await codebaseContext.readFile(diff.filePath);
      const signals = extractStructuralSignals(diff);

      const toolContext: ToolContext = {
        filePath: diff.filePath,
        fullContent,
        toolkit: config.toolkit,
        repoName: pullRequest.repo,
      };

      const userPrompt = buildToolUseFilePrompt({
        fileDiff: diff,
        signals,
        prTitle: pullRequest.prTitle,
        prDescription: pullRequest.prDescription,
        availablePatterns,
      });

      const { content, usage } = await client.completeWithTools({
        systemPrompt,
        userPrompt,
        tools: openAiTools,
        onToolCall: (toolName, rawArgs) => executeToolCall(REVIEW_TOOLS, toolContext, toolName, rawArgs),
        maxTokens: MAX_REVIEW_RESPONSE_TOKENS,
        toolTokenBudget: TOOL_TOKEN_BUDGET,
      });
      const findings = parseLlmResponse(content, diff, pullRequest);
      allFindings.push(...findings);
      combinedUsage = mergeUsage(combinedUsage, usage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedFiles.push({ filePath: diff.filePath, error: message });
      continue;
    }
  }

  return { findings: allFindings, failedFiles, usage: combinedUsage };
}

/**
 * Critic stage with graceful degradation.
 */
async function runCriticStage(
  findings: readonly Finding[],
  codebaseContext: CodebaseContext,
  client: ReviewClient,
): Promise<{ result: CriticResult; usage: CompletionUsage | undefined }> {
  try {
    const fileContents = await collectFileContents(
      findings,
      (path) => codebaseContext.readFile(path),
    );
    return await criticFindings(findings, fileContents, client);
  } catch {
    return { result: { findings, filtered: [] }, usage: undefined };
  }
}

/**
 * Runs the three-stage review pipeline: triage, review, critic.
 *
 * @remarks
 * Each stage degrades gracefully on failure:
 * - Triage failure: all files treated as high priority
 * - Critic failure: unfiltered findings returned
 * - Individual file review failure: file skipped, others continue
 *
 * @param diffs - File diffs already filtered by file-selection.
 * @param pullRequest - PR metadata for finding attribution.
 * @param codebaseContext - Repository context with file reader.
 * @param config - Pipeline configuration including model selection.
 * @returns Findings, triage results, critic report, and token usage.
 */
export async function runReviewPipeline(
  diffs: readonly FileDiff[],
  pullRequest: PullRequestMetadata,
  codebaseContext: CodebaseContext,
  config: ReviewPipelineConfig,
): Promise<ReviewPipelineResult> {
  const clients = createPipelineClients(config);
  const rawMaxFiles = config.maxFilesPerReview ?? undefined;
  const maxFiles = typeof rawMaxFiles === "number" && Number.isFinite(rawMaxFiles) && rawMaxFiles > 0
    ? Math.floor(rawMaxFiles)
    : DEFAULT_MAX_FILES;

  const triageOutput = await runTriageStage(diffs, clients.triageClient);

  const selectedDiffs = selectAndPrioritise(diffs, triageOutput.results, maxFiles);

  const reviewOutput = await runReviewStage({
    diffs: selectedDiffs,
    pullRequest,
    codebaseContext,
    client: clients.reviewClient,
    config,
  });

  const criticOutput = await runCriticStage(
    reviewOutput.findings, codebaseContext, clients.criticClient,
  );

  return {
    findings: criticOutput.result.findings,
    triageResults: triageOutput.results,
    criticReport: criticOutput.result,
    tokenUsage: buildTokenUsage(triageOutput.usage, reviewOutput.usage, criticOutput.usage),
    failedFiles: reviewOutput.failedFiles,
  };
}
