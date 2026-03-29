import { describe, expect, test } from "bun:test";
import {
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
} from "@mergewise/shared-types";
import type { EvalFixture } from "./types";
import { scoreReviewQualityHeuristics } from "./review-quality";

function makeFinding(line: number, recommendation: string) {
  return {
    findingId: `test:${line}`,
    installationId: toInstallationId(1),
    repo: toRepoFullName("eval/fixture"),
    prNumber: toPRNumber(1),
    language: "typescript",
    ruleId: toRuleId("llm/reviewer"),
    category: "clean" as const,
    filePath: toFilePath("src/example.ts"),
    line: toLineNumber(line),
    evidence: "example evidence",
    recommendation,
    confidence: toConfidence(0.9),
    status: "posted" as const,
  };
}

function makeFixture(): EvalFixture {
  return {
    fixtureId: "quality-fixture",
    fileDiff: {
      filePath: toFilePath("src/example.ts"),
      previousPath: null,
      hunks: [{ header: "@@ -0,0 +1,10 @@", lines: ["+const value = 1"] }],
    },
    fullFileContent: "const value = 1",
    sourceFiles: new Map([["src/example.ts", "const value = 1"]]),
    expectations: [],
    config: {
      executionMode: "pipeline",
      reviewQuality: {
        summary: "Test quality fixture",
        reviewGoal: "Prioritise the main concern and stay restrained",
        mustFind: [{
          description: "Main issue",
          matchLineRange: [1, 10],
          matchRecommendationContainsAny: ["extract", "split"],
          required: true,
        }],
        mustAvoid: [{
          description: "Avoid generic nit",
          matchLineRange: [1, 10],
          matchRecommendationContainsAny: ["rename", "style"],
          required: false,
        }],
        findingCountRange: [1, 2],
        prioritise: [{
          description: "Top comment should be the main issue",
          matchLineRange: [1, 10],
          matchRecommendationContainsAny: ["extract", "split"],
          required: true,
        }],
      },
    },
  };
}

describe("scoreReviewQualityHeuristics", () => {
  test("returns null when no review-quality rubric is configured", () => {
    const fixture = makeFixture();
    const heuristics = scoreReviewQualityHeuristics([], {
      ...fixture,
      config: {},
    });
    expect(heuristics).toBeNull();
  });

  test("scores coverage, restraint, and prioritisation for a strong review", () => {
    const heuristics = scoreReviewQualityHeuristics(
      [makeFinding(3, "Extract the fetching logic into a hook and split rendering concerns.")],
      makeFixture(),
    );

    expect(heuristics).not.toBeNull();
    expect(heuristics?.mustFindCoverage).toBe(1);
    expect(heuristics?.prioritisation).toBe(1);
    expect(heuristics?.restraint).toBe(1);
  });

  test("penalises avoidable findings and incorrect finding count", () => {
    const heuristics = scoreReviewQualityHeuristics(
      [
        makeFinding(3, "Rename this for style."),
        makeFinding(4, "Rename this for style too."),
        makeFinding(5, "Rename this for style three."),
      ],
      makeFixture(),
    );

    expect(heuristics).not.toBeNull();
    expect(heuristics?.mustFindCoverage).toBe(0);
    expect(heuristics?.restraint).toBeLessThan(1);
    expect(heuristics?.prioritisation).toBe(0);
  });
});
