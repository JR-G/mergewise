import { fetchFileContent } from "@mergewise/github-client";
import { DEFAULT_MERGEWISE_CONFIG, type MergewiseConfig } from "@mergewise/config-loader";
import { executeRules } from "@mergewise/rule-engine";
import { tsReactRules } from "@mergewise/rule-ts-react";
import { createLlmReviewerRule } from "@mergewise/llm-reviewer";
import { compileLearnings } from "@mergewise/feedback-store";
import type {
  AnalyzePullRequestJob,
  CodebaseContext,
  RepoLearnings,
  Rule,
} from "@mergewise/shared-types";
import {
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
  resolveGitHubFetchOptions,
  type WorkerGitHubFetchOptions,
} from "./config";
import {
  type AnalyzePullRequestJobSummary,
  buildIdempotencyKey,
  resolveJobTraceId,
  buildJobSummary,
  selectRulesForExecution,
  applyFindingGates,
} from "./job-utils";
import {
  type WorkerFindingDeliveryOptions,
  prepareFindingDelivery,
  buildWorkerCheckOutput,
} from "./delivery";
import { buildAnalysisContextFromGitHub } from "./github-fetch";
import type { WorkerProcessingDependencies, ResolvedLoggers } from "./process-job-types";
import {
  type CheckRunContext,
  fetchPullRequestState,
  handleClosedPullRequestExit,
  ensureCheckRunInProgress,
  finaliseCheckRun,
} from "./check-run-lifecycle";
import { deliverFindingsToGitHub } from "./finding-delivery";

export type { WorkerProcessingDependencies } from "./process-job-types";

interface ResolvedProcessingConfig {
  readonly key: string;
  readonly traceId: string;
  readonly loggers: ResolvedLoggers;
  readonly mergewiseConfig: MergewiseConfig;
  readonly selectedRules: readonly Rule[];
  readonly executeRulesFn: typeof executeRules;
  readonly githubFetchOptions: WorkerGitHubFetchOptions;
  readonly findingDeliveryOptions: WorkerFindingDeliveryOptions;
}

function resolveLoggers(dependencies: WorkerProcessingDependencies): ResolvedLoggers {
  const infoLogger = dependencies.logInfo ?? console.log;
  const errorLogger = dependencies.logError ?? console.error;
  const warnLogger = dependencies.logWarn ?? infoLogger;
  return { infoLogger, errorLogger, warnLogger };
}

function buildLlmRules(
  mergewiseConfig: MergewiseConfig,
  traceId: string,
  loggers: ResolvedLoggers,
  repoLearnings?: RepoLearnings,
): readonly Rule[] {
  const llmConfig = mergewiseConfig.llm;
  const llmApiKey = process.env.LLM_API_KEY;
  const llmEnabled = llmConfig.enabled && llmApiKey !== undefined && llmApiKey.length > 0;

  if (!llmEnabled || !llmApiKey) {
    return [];
  }

  return [
    createLlmReviewerRule({
      clientConfig: {
        apiKey: llmApiKey,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
      },
      tokenBudget: llmConfig.tokenBudget,
      consistencySamples: llmConfig.consistencySamples,
      usePipeline: llmConfig.usePipeline,
      triageModel: llmConfig.triageModel,
      criticModel: llmConfig.criticModel,
      userSkipPatterns: mergewiseConfig.review.skipPatterns.length > 0
        ? mergewiseConfig.review.skipPatterns
        : undefined,
      confidenceThreshold: mergewiseConfig.gating.confidenceThreshold,
      repoLearnings,
      onFileReviewError: (filePath, error) => {
        loggers.warnLogger(
          `[worker] llm review failed trace=${traceId} file=${filePath} error=${error instanceof Error ? error.message : String(error)}`,
        );
      },
      onFileReviewComplete: (filePath, findingCount, promptTokens, completionTokens) => {
        loggers.infoLogger(
          `[worker] llm_usage trace=${traceId} file=${filePath} findings=${findingCount} prompt_tokens=${promptTokens} completion_tokens=${completionTokens} total_tokens=${promptTokens + completionTokens}`,
        );
      },
    }),
  ];
}

function resolveProcessingConfig(
  job: AnalyzePullRequestJob,
  dependencies: WorkerProcessingDependencies,
): ResolvedProcessingConfig {
  const key = buildIdempotencyKey(job);
  const traceId = resolveJobTraceId(job);
  const loggers = resolveLoggers(dependencies);
  const mergewiseConfig = dependencies.mergewiseConfig ?? DEFAULT_MERGEWISE_CONFIG;

  let repoLearnings: RepoLearnings | undefined;
  if (dependencies.feedbackStore) {
    try {
      repoLearnings = compileLearnings(job.repo_full_name, dependencies.feedbackStore);
      if (repoLearnings.summary !== "no learnings") {
        loggers.infoLogger(
          `[worker] learnings trace=${traceId} repo=${job.repo_full_name} ${repoLearnings.summary}`,
        );
      }
    } catch (learningError) {
      const detail = learningError instanceof Error ? learningError.message : String(learningError);
      loggers.errorLogger(
        `[worker] compile_learnings_failed trace=${traceId} repo=${job.repo_full_name}: ${detail}`,
      );
    }
  }

  const baseLlmRules = buildLlmRules(mergewiseConfig, traceId, loggers, repoLearnings);
  const rules = dependencies.rules ?? [...tsReactRules, ...baseLlmRules];

  const baseBlockedRuleIds = dependencies.findingDeliveryOptions?.blockedRuleIds
    ?? DEFAULT_BLOCKED_POST_RULE_IDS;
  const blockedRuleIds = [...baseBlockedRuleIds];
  if (repoLearnings) {
    const blockedSet = new Set(blockedRuleIds);
    for (const suppressedRuleId of repoLearnings.suppressedRules) {
      if (!blockedSet.has(suppressedRuleId)) {
        blockedRuleIds.push(suppressedRuleId);
      }
    }
  }

  const baseFindingDeliveryOptions = dependencies.findingDeliveryOptions ?? {
    confidenceThreshold: mergewiseConfig.gating.confidenceThreshold,
    maxComments: mergewiseConfig.gating.maxComments,
    testFileConfidenceThreshold: DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
    allowedCategories: DEFAULT_ALLOWED_POST_CATEGORIES,
  };

  return {
    key,
    traceId,
    loggers,
    mergewiseConfig,
    selectedRules: selectRulesForExecution(rules, mergewiseConfig),
    executeRulesFn: dependencies.executeRulesFn ?? executeRules,
    githubFetchOptions: dependencies.githubFetchOptions ?? resolveGitHubFetchOptions(),
    findingDeliveryOptions: { ...baseFindingDeliveryOptions, blockedRuleIds },
  };
}

function buildCodebaseContext(
  ctx: CheckRunContext,
  selectedRules: readonly Rule[],
): CodebaseContext | undefined {
  const hasCodebaseAwareRules = selectedRules.some((rule) => rule.kind === "codebase-aware");
  if (!hasCodebaseAwareRules) {
    return undefined;
  }

  return {
    symbols: [],
    conventions: new Map<string, string>(),
    readFile: async (relativePath: string) => {
      try {
        return await fetchFileContent({
          owner: ctx.githubAnalysisContext.owner,
          repository: ctx.githubAnalysisContext.repository,
          path: relativePath,
          ref: ctx.job.head_sha,
          installationAccessToken: ctx.githubAnalysisContext.installationAccessToken,
          apiBaseUrl: ctx.githubFetchOptions.githubApiBaseUrl,
          userAgent: ctx.githubFetchOptions.githubUserAgent,
          requestTimeoutMs: ctx.githubFetchOptions.githubRequestTimeoutMs,
          traceId: ctx.traceId,
        });
      } catch (caughtError) {
        const detail = caughtError instanceof Error ? caughtError.message : String(caughtError);
        ctx.loggers.errorLogger(
          `[worker] readFile failed trace=${ctx.traceId} job=${ctx.job.job_id} file=${relativePath} ref=${ctx.job.head_sha} repo=${ctx.githubAnalysisContext.owner}/${ctx.githubAnalysisContext.repository}: ${detail}`,
        );
        throw new Error(
          `Failed to read ${relativePath} at ${ctx.job.head_sha} for ${ctx.githubAnalysisContext.owner}/${ctx.githubAnalysisContext.repository}`,
          { cause: caughtError },
        );
      }
    },
  };
}

/**
 * Processes a queued analysis job through GitHub fetch, rule execution, and summary generation.
 *
 * @param job - Job payload to process.
 * @param dependencies - Optional dependency overrides.
 * @returns Deterministic processing summary for this job.
 */
export async function processAnalyzePullRequestJob(
  job: AnalyzePullRequestJob,
  dependencies: WorkerProcessingDependencies = {},
): Promise<AnalyzePullRequestJobSummary> {
  const config = resolveProcessingConfig(job, dependencies);
  const { traceId, loggers, githubFetchOptions } = config;

  loggers.infoLogger(
    `[worker] processing trace=${traceId} job=${job.job_id} key=${config.key} installation=${job.installation_id ?? "none"} rules=${config.selectedRules.length}`,
  );

  const githubAnalysisContext = await buildAnalysisContextFromGitHub(
    job,
    githubFetchOptions,
    {
      createGitHubAppJwtFn: dependencies.createGitHubAppJwtFn,
      exchangeInstallationAccessTokenFn: dependencies.exchangeInstallationAccessTokenFn,
      fetchPullRequestFilesWithRetryFn: dependencies.fetchPullRequestFilesWithRetryFn,
      logWarn: loggers.warnLogger,
      logInfo: loggers.infoLogger,
      logError: loggers.errorLogger,
    },
  );

  const ctx: CheckRunContext = { job, githubAnalysisContext, githubFetchOptions, traceId, loggers };

  const pullRequestState = await fetchPullRequestState(
    { job, githubAnalysisContext, githubFetchOptions, traceId },
    dependencies,
  );

  if (pullRequestState.state !== "open") {
    return await handleClosedPullRequestExit(ctx, pullRequestState, dependencies);
  }

  let pendingCheckRunId: number | undefined;
  if (dependencies.deliveryMode === "github") {
    pendingCheckRunId = await ensureCheckRunInProgress(ctx, dependencies);
  }

  const codebaseContext = buildCodebaseContext(ctx, config.selectedRules);
  const executionResult = await config.executeRulesFn({
    context: githubAnalysisContext.analysisContext,
    rules: config.selectedRules,
    codebaseContext,
    onRuleExecutionError: (rule, error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      loggers.errorLogger(
        `[worker] rule failure trace=${traceId} job=${job.job_id} rule=${rule.metadata.ruleId}: ${detail}`,
      );
    },
  });

  const gatedExecutionResult = applyFindingGates(executionResult, config.mergewiseConfig);
  const delivery = prepareFindingDelivery(executionResult.findings, config.findingDeliveryOptions);

  let postedCommentCount = 0;
  if (dependencies.deliveryMode === "github") {
    postedCommentCount = await deliverFindingsToGitHub(
      { ...ctx, gatedExecutionResult, delivery },
      dependencies,
    );
  }

  return buildProcessingSummary({
    job, config, gatedExecutionResult, delivery,
    postedCommentCount, ctx, pendingCheckRunId, dependencies,
  });
}

interface ProcessingSummaryInput {
  readonly job: AnalyzePullRequestJob;
  readonly config: ResolvedProcessingConfig;
  readonly gatedExecutionResult: Awaited<ReturnType<typeof executeRules>>;
  readonly delivery: ReturnType<typeof prepareFindingDelivery>;
  readonly postedCommentCount: number;
  readonly ctx: CheckRunContext;
  readonly pendingCheckRunId: number | undefined;
  readonly dependencies: WorkerProcessingDependencies;
}

async function buildProcessingSummary(
  input: ProcessingSummaryInput,
): Promise<AnalyzePullRequestJobSummary> {
  const { job, config, gatedExecutionResult, delivery, postedCommentCount, ctx, pendingCheckRunId, dependencies } = input;
  const checkOutput = buildWorkerCheckOutput(gatedExecutionResult, delivery, postedCommentCount, {
    repositoryFullName: job.repo_full_name,
    headSha: job.head_sha,
  });

  const summary = buildJobSummary(
    job,
    config.key,
    gatedExecutionResult,
    (dependencies.now ?? (() => new Date()))().toISOString(),
  );

  config.loggers.infoLogger(
    `[worker] summary trace=${summary.traceId} job=${summary.jobId} findings=${summary.totalFindings} rules_ok=${summary.successfulRules}/${summary.totalRules}`,
  );
  config.loggers.infoLogger(
    `[worker] check_output trace=${summary.traceId} job=${summary.jobId} payload=${JSON.stringify(checkOutput)}`,
  );

  if (dependencies.deliveryMode === "github") {
    await finaliseCheckRun(ctx, pendingCheckRunId, checkOutput, dependencies);
  }

  return {
    ...summary,
    postedCommentCount,
    skippedByConfidence: delivery.skippedByConfidence,
    skippedByDeduplication: delivery.skippedByDeduplication,
    skippedByPolicy: delivery.skippedByPolicy,
    skippedByGrouping: delivery.skippedByGrouping,
    skippedBySimilarity: delivery.skippedBySimilarity,
    skippedByCap: delivery.skippedByCap,
    checkOutput,
  };
}
