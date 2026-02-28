import {
  ANTI_PATTERNS,
  ReviewClient,
  buildFileReviewPrompt,
  buildSystemPrompt,
  extractStructuralSignals,
  parseLlmResponse,
} from "@mergewise/llm-reviewer";
import type { EvalFixture, EvalResult, EvalVariant } from "./types";
import { scoreFindings } from "./scorer";
import { STUB_PR_METADATA } from "./loader";

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
): Promise<EvalResult> {
  const client = new ReviewClient(variant.clientConfig);
  const antiPatterns = variant.antiPatterns ?? ANTI_PATTERNS;

  const systemPrompt = buildSystemPrompt(antiPatterns, variant.confidenceThreshold);
  const signals = extractStructuralSignals(fixture.fileDiff);
  const userPrompt = buildFileReviewPrompt(
    fixture.fileDiff,
    fixture.fullFileContent,
    signals,
  );

  const start = performance.now();
  let rawResponse: string;
  try {
    const completion = await client.complete(systemPrompt, userPrompt, 4096);
    rawResponse = completion.content;
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    throw new Error(
      `LLM completion failed for fixture "${fixture.fixtureId}" variant "${variant.label}" after ${durationMs}ms`,
      { cause: error },
    );
  }
  const durationMs = Math.round(performance.now() - start);

  const findings = parseLlmResponse(
    rawResponse,
    fixture.fileDiff,
    STUB_PR_METADATA,
  );

  const score = scoreFindings(findings, fixture.expectations);

  return {
    fixtureId: fixture.fixtureId,
    variant: variant.label,
    score,
    findings,
    durationMs,
  };
}
