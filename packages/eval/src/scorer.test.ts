import { describe, expect, test } from "bun:test";
import type { Finding } from "@mergewise/shared-types";
import type { ExpectedFinding } from "./types";
import { matchFinding, scoreFindings } from "./scorer";

function makeFinding(
  overrides: Partial<Finding> & Pick<Finding, "line" | "category" | "confidence">,
): Finding {
  return {
    findingId: `test:${overrides.line}:${overrides.category}`,
    installationId: 1,
    repo: "eval/fixture",
    prNumber: 0,
    language: "typescript",
    ruleId: "llm/reviewer",
    filePath: "src/file.ts",
    evidence: "some code",
    recommendation: "fix it",
    status: "posted",
    ...overrides,
  };
}

describe("matchFinding", () => {
  test("matches when all specified fields match", () => {
    const finding = makeFinding({
      line: 5,
      category: "clean",
      confidence: 0.9,
      evidence: "const data = fetch()",
      recommendation: "Extract into a custom hook",
    });

    const expectation: ExpectedFinding = {
      description: "test",
      matchLineRange: [1, 10],
      matchCategory: "clean",
      matchRecommendationContainsAny: ["extract", "hook"],
      required: true,
    };

    expect(matchFinding(finding, expectation)).toBe(true);
  });

  test("rejects when line is outside range", () => {
    const finding = makeFinding({ line: 15, category: "clean", confidence: 0.9 });
    const expectation: ExpectedFinding = {
      description: "test",
      matchLineRange: [1, 10],
      required: true,
    };

    expect(matchFinding(finding, expectation)).toBe(false);
  });

  test("rejects when category does not match", () => {
    const finding = makeFinding({ line: 5, category: "perf", confidence: 0.9 });
    const expectation: ExpectedFinding = {
      description: "test",
      matchCategory: "clean",
      required: true,
    };

    expect(matchFinding(finding, expectation)).toBe(false);
  });
});

describe("scoreFindings", () => {
  test("perfect recall when all required expectations matched", () => {
    const findings = [
      makeFinding({ line: 5, category: "clean", confidence: 0.9, recommendation: "Extract hook" }),
    ];
    const expectations: ExpectedFinding[] = [
      {
        description: "Flags extraction opportunity",
        matchLineRange: [1, 10],
        matchRecommendationContainsAny: ["extract"],
        required: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.recall).toBe(1.0);
    expect(score.requiredMatched).toBe(1);
  });

  test("zero recall when required expectation not matched", () => {
    const findings = [
      makeFinding({ line: 50, category: "perf", confidence: 0.9 }),
    ];
    const expectations: ExpectedFinding[] = [
      {
        description: "Expected clean finding near line 5",
        matchLineRange: [1, 10],
        matchCategory: "clean",
        required: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.recall).toBe(0);
    expect(score.requiredMatched).toBe(0);
  });

  test("counts forbidden matches as false positives", () => {
    const findings = [
      makeFinding({
        line: 3,
        category: "safety",
        confidence: 0.85,
        recommendation: "Fix the null check",
      }),
    ];
    const expectations: ExpectedFinding[] = [
      {
        description: "Should not flag comment lines",
        matchLineRange: [1, 5],
        matchCategory: "safety",
        required: false,
        forbidden: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.falsePositiveCount).toBe(1);
    expect(score.unmatchedFindings).toHaveLength(0);
  });

  test("forbidden findings do not count as matched", () => {
    const findings = [
      makeFinding({ line: 3, category: "clean", confidence: 0.9 }),
    ];
    const expectations: ExpectedFinding[] = [
      {
        description: "Forbidden",
        matchLineRange: [1, 5],
        required: false,
        forbidden: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.matchedFindings).toBe(0);
    expect(score.falsePositiveCount).toBe(1);
    expect(score.precision).toBe(0);
  });

  test("mixed forbidden and required expectations scored correctly", () => {
    const findings = [
      makeFinding({ line: 5, category: "clean", confidence: 0.9, recommendation: "Extract" }),
      makeFinding({ line: 12, category: "safety", confidence: 0.8, recommendation: "Fix null" }),
    ];
    const expectations: ExpectedFinding[] = [
      {
        description: "Expected extraction suggestion",
        matchLineRange: [1, 10],
        matchCategory: "clean",
        required: true,
      },
      {
        description: "Should not flag safety on line 12",
        matchLineRange: [10, 15],
        matchCategory: "safety",
        required: false,
        forbidden: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.requiredMatched).toBe(1);
    expect(score.recall).toBe(1.0);
    expect(score.falsePositiveCount).toBe(1);
    expect(score.matchedFindings).toBe(1);
  });

  test("optimal matching succeeds where greedy assignment would fail", () => {
    const findings = [
      makeFinding({
        line: 5,
        category: "clean",
        confidence: 0.9,
        recommendation: "Extract function",
      }),
      makeFinding({
        line: 5,
        category: "clean",
        confidence: 0.9,
        recommendation: "Extract function and rename variable",
      }),
    ];

    const expectations: ExpectedFinding[] = [
      {
        description: "Greedy would consume finding[0] here via 'extract'",
        matchLineRange: [1, 10],
        matchCategory: "clean",
        matchRecommendationContainsAny: ["extract"],
        required: true,
      },
      {
        description: "Only finding[1] matches (contains 'rename' in its recommendation)",
        matchLineRange: [1, 10],
        matchCategory: "clean",
        matchRecommendationContains: "rename",
        required: true,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.requiredMatched).toBe(2);
    expect(score.recall).toBe(1.0);
  });

  test("optimal matching for optional expectations", () => {
    const findings = [
      makeFinding({ line: 10, category: "perf", confidence: 0.7, recommendation: "Cache result" }),
      makeFinding({ line: 10, category: "perf", confidence: 0.7, recommendation: "Cache result and batch" }),
    ];

    const expectations: ExpectedFinding[] = [
      {
        description: "Greedy would consume finding[0] via 'cache'",
        matchCategory: "perf",
        matchRecommendationContainsAny: ["cache"],
        required: false,
      },
      {
        description: "Only finding[1] matches 'batch', but greedy took finding[0] for first",
        matchCategory: "perf",
        matchRecommendationContains: "batch",
        required: false,
      },
    ];

    const score = scoreFindings(findings, expectations);
    expect(score.matchedFindings).toBe(2);
  });

  test("no findings produces perfect scores with zero false positives", () => {
    const score = scoreFindings([], []);
    expect(score.recall).toBe(1.0);
    expect(score.precision).toBe(1.0);
    expect(score.falsePositiveCount).toBe(0);
  });
});
