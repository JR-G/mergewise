import {
  ANTI_PATTERNS,
  ReviewClient,
  buildFileReviewPrompt,
  buildSystemPrompt,
  extractStructuralSignals,
  parseLlmResponse,
  runReviewPipeline,
} from "@mergewise/llm-reviewer";
import type { Finding } from "@mergewise/shared-types";
import type {
  EvalExecutionInput,
  EvalExecutionMode,
  EvalFixture,
  EvalResult,
  EvalRunOptions,
  EvalVariant,
} from "./types";
import { scoreFindings } from "./scorer";
import { STUB_PR_METADATA } from "./loader";
import { scoreReviewQuality } from "./review-quality";

function buildExecutionInput(fixture: EvalFixture): EvalExecutionInput {
  const pullRequest = {
    ...STUB_PR_METADATA,
    prTitle: fixture.config.prTitle,
    prDescription: fixture.config.prDescription,
  };

  return {
    fixture,
    pullRequest,
    codebaseContextReadFile: (relativePath: string) =>
      Promise.resolve(fixture.sourceFiles.get(relativePath) ?? null),
  };
}

async function runLegacyFixture(
  fixture: EvalFixture,
  variant: EvalVariant,
): Promise<readonly Finding[]> {
  const client = new ReviewClient(variant.clientConfig);
  const antiPatterns = variant.antiPatterns ?? ANTI_PATTERNS;
  const systemPrompt = buildSystemPrompt(antiPatterns, variant.confidenceThreshold);
  const signals = extractStructuralSignals(fixture.fileDiff);
  const userPrompt = buildFileReviewPrompt({
    fileDiff: fixture.fileDiff,
    fullContent: fixture.fullFileContent,
    signals,
  });

  const completion = await client.complete(systemPrompt, userPrompt, 4096);
  return parseLlmResponse(
    completion.content,
    fixture.fileDiff,
    {
      ...STUB_PR_METADATA,
      prTitle: fixture.config.prTitle,
      prDescription: fixture.config.prDescription,
    },
  );
}

async function runPipelineFixture(
  input: EvalExecutionInput,
  variant: EvalVariant,
): Promise<readonly Finding[]> {
  const result = await runReviewPipeline(
    [input.fixture.fileDiff],
    input.pullRequest,
    {
      symbols: [],
      conventions: new Map(),
      readFile: input.codebaseContextReadFile,
    },
    {
      triageModel: variant.clientConfig.model,
      reviewModel: variant.clientConfig.model ?? "gpt-4.1",
      criticModel: variant.clientConfig.model,
      maxFilesPerReview: input.fixture.config.maxFilesPerReview,
      apiKey: variant.clientConfig.apiKey,
      baseUrl: variant.clientConfig.baseUrl,
      maxRetries: variant.clientConfig.maxRetries,
      knowledgeEnabled: variant.antiPatterns === undefined ? true : variant.antiPatterns.length > 0,
    },
  );

  return result.findings;
}

function resolveExecutionMode(
  fixture: EvalFixture,
  options: EvalRunOptions | undefined,
): EvalExecutionMode {
  return options?.executionMode ?? fixture.config.executionMode ?? "pipeline";
}

/**
 * Runs a single fixture against a variant and returns a scored result.
 *
 * @param fixture - Loaded eval fixture.
 * @param variant - Variant configuration (model, anti-patterns).
 * @returns Scored evaluation result with timing.
 */
export async function runFixture(
  fixture: EvalFixture,
  variant: EvalVariant,
  options?: EvalRunOptions,
): Promise<EvalResult> {
  const executionMode = resolveExecutionMode(fixture, options);
  const executionInput = buildExecutionInput(fixture);
  const start = performance.now();
  try {
    const findings = executionMode === "pipeline"
      ? await runPipelineFixture(executionInput, variant)
      : await runLegacyFixture(fixture, variant);
    const durationMs = Math.round(performance.now() - start);
    const score = scoreFindings(findings, fixture.expectations);
    const reviewQuality = await scoreReviewQuality(
      [...findings],
      fixture,
      options?.judgeClientConfig,
    );

    return {
      fixtureId: fixture.fixtureId,
      variant: variant.label,
      executionMode,
      score,
      findings: [...findings],
      reviewQuality,
      durationMs,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    throw new Error(
      `LLM completion failed for fixture "${fixture.fixtureId}" variant "${variant.label}" in ${executionMode} mode after ${durationMs}ms`,
      { cause: error },
    );
  }
}
