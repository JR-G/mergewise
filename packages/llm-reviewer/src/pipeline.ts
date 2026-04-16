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
  FileTokenUsage,
  ReviewPipelineConfig,
  ReviewPipelineResult,
  TokenUsageSummary,
  TriageResult,
} from "./pipeline-types";
import { triageFiles } from "./triage";
import { criticFindings, collectFileContents } from "./critic";
import { extractReviewSignals, extractStructuralSignals, type ReviewSignals } from "./signals";
import { buildSlimSystemPrompt, buildToolUseFilePrompt } from "./prompt-slim";
import { parseLlmResponse } from "./schema";
import { REVIEW_TOOLS, toOpenAiTools, executeToolCall, buildAvailablePatternsSummary, lookupPattern } from "./review-tools";
import type { ToolContext } from "./review-tools";

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  high: 0,
  medium: 1,
  low: 2,
  skip: 3,
};

const DEFAULT_MAX_FILES = 20;
const MAX_REVIEW_RESPONSE_TOKENS = 4096;
const DEFAULT_TOKEN_BUDGET = 30_000;
const MIN_PER_FILE_TOOL_BUDGET = 5_000;

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
  perFileUsage: readonly FileTokenUsage[],
): TokenUsageSummary {
  const totalUsage = mergeUsage(mergeUsage(triageUsage, reviewUsage), criticUsage);
  return { triageUsage, reviewUsage, criticUsage, totalUsage, perFileUsage };
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

interface ReviewedFileOutput {
  readonly findings: readonly Finding[];
  readonly usage: CompletionUsage | undefined;
  readonly reviewSignals: ReviewSignals;
}

type ActiveReviewTool = (typeof REVIEW_TOOLS)[number];

interface SingleDiffReviewInput {
  readonly diff: FileDiff;
  readonly pullRequest: PullRequestMetadata;
  readonly client: ReviewClient;
  readonly config: ReviewPipelineConfig;
  readonly systemPrompt: string;
  readonly enabledTools: readonly ActiveReviewTool[];
  readonly openAiTools: ReturnType<typeof toOpenAiTools>;
  readonly availablePatterns: string;
  readonly perFileToolBudget: number;
  readonly fullContent: string | null;
}

async function reviewSingleDiff(input: SingleDiffReviewInput): Promise<ReviewedFileOutput> {
  const {
    diff,
    pullRequest,
    client,
    config,
    systemPrompt,
    enabledTools,
    openAiTools,
    availablePatterns,
    perFileToolBudget,
    fullContent,
  } = input;
  const signals = extractStructuralSignals(diff);
  const reviewSignals = extractReviewSignals(diff);

  const toolContext: ToolContext = {
    filePath: diff.filePath,
    fullContent,
    toolkit: config.toolkit,
    repoName: pullRequest.repo,
  };
  const graphContext = config.toolkit?.getCallers?.(diff.filePath);
  const learnings = config.toolkit?.getRepoLearnings?.(pullRequest.repo, [diff.filePath]);

  const userPrompt = buildToolUseFilePrompt({
    fileDiff: diff,
    fullContent,
    signals,
    reviewSignals,
    ...(graphContext ? { graphContext } : {}),
    ...(learnings ? { learnings } : {}),
    prTitle: pullRequest.prTitle,
    prDescription: pullRequest.prDescription,
    availablePatterns,
  });

  const { content, usage } = await client.completeWithTools({
    systemPrompt,
    userPrompt,
    tools: openAiTools,
    onToolCall: (toolName, rawArgs) => executeToolCall(enabledTools, toolContext, toolName, rawArgs),
    maxTokens: MAX_REVIEW_RESPONSE_TOKENS,
    toolTokenBudget: perFileToolBudget,
  });

  return {
    findings: parseLlmResponse(content, diff, pullRequest),
    usage,
    reviewSignals,
  };
}

/**
 * Review stage: per-file review with retrieved knowledge context.
 */
async function runReviewStage(
  input: ReviewStageInput,
): Promise<{
  findings: Finding[];
  failedFiles: FileReviewFailure[];
  usage: CompletionUsage | undefined;
  perFileUsage: FileTokenUsage[];
  reviewSignalsByFile: ReadonlyMap<string, ReviewSignals>;
}> {
  const { diffs, pullRequest, codebaseContext, client, config } = input;
  const systemPrompt = buildSlimSystemPrompt({ agentFriendliness: config.agentFriendliness, toolUse: true });
  const enabledTools = config.knowledgeEnabled === false
    ? REVIEW_TOOLS.filter((tool) => tool !== lookupPattern)
    : REVIEW_TOOLS;
  const openAiTools = toOpenAiTools(enabledTools);
  const availablePatterns = config.knowledgeEnabled === false
    ? "Pattern lookup disabled for this run."
    : buildAvailablePatternsSummary();
  const allFindings: Finding[] = [];
  const failedFiles: FileReviewFailure[] = [];
  const perFileUsage: FileTokenUsage[] = [];
  const reviewSignalsByFile = new Map<string, ReviewSignals>();
  let combinedUsage: CompletionUsage | undefined;

  const perFileToolBudget = Math.max(
    MIN_PER_FILE_TOOL_BUDGET,
    Math.floor((config.tokenBudget ?? DEFAULT_TOKEN_BUDGET) / diffs.length),
  );

  for (const diff of diffs) {
    let fullContent: string | null;
    try {
      fullContent = await codebaseContext.readFile(diff.filePath);
    } catch {
      fullContent = null;
    }

    try {
      const reviewedFile = await reviewSingleDiff({
        diff,
        pullRequest,
        client,
        config,
        systemPrompt,
        enabledTools,
        openAiTools,
        availablePatterns,
        perFileToolBudget,
        fullContent,
      });
      const { findings, usage, reviewSignals } = reviewedFile;
      reviewSignalsByFile.set(diff.filePath, reviewSignals);
      allFindings.push(...findings);
      combinedUsage = mergeUsage(combinedUsage, usage);
      perFileUsage.push({
        filePath: diff.filePath,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedFiles.push({ filePath: diff.filePath, error: message });
      continue;
    }
  }

  return { findings: allFindings, failedFiles, usage: combinedUsage, perFileUsage, reviewSignalsByFile };
}

/**
 * Critic stage with graceful degradation.
 */
async function runCriticStage(
  findings: readonly Finding[],
  codebaseContext: CodebaseContext,
  client: ReviewClient,
  reviewSignalsByFile: ReadonlyMap<string, ReviewSignals>,
): Promise<{ result: CriticResult; usage: CompletionUsage | undefined }> {
  try {
    const fileContents = await collectFileContents(
      findings,
      (path) => codebaseContext.readFile(path),
    );
    return await criticFindings(findings, fileContents, client, reviewSignalsByFile);
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
    reviewOutput.findings, codebaseContext, clients.criticClient, reviewOutput.reviewSignalsByFile,
  );

  return {
    findings: criticOutput.result.findings,
    triageResults: triageOutput.results,
    criticReport: criticOutput.result,
    tokenUsage: buildTokenUsage(triageOutput.usage, reviewOutput.usage, criticOutput.usage, reviewOutput.perFileUsage),
    failedFiles: reviewOutput.failedFiles,
  };
}
