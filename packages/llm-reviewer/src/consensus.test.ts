import { describe, expect, test } from "bun:test";
import type { Finding } from "@mergewise/shared-types";
import {
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
} from "@mergewise/shared-types";
import {
  applyConsensusFilter,
  extractWordTokens,
  jaccardSimilarity,
} from "./consensus";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: "test-finding",
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(42),
    language: "typescript",
    ruleId: toRuleId("llm/reviewer"),
    category: "clean",
    filePath: toFilePath("src/index.ts"),
    line: toLineNumber(10),
    evidence: "test evidence",
    recommendation: "extract this duplicated logic into a shared helper function",
    confidence: toConfidence(0.85),
    status: "posted",
    ...overrides,
  };
}

describe("extractWordTokens", () => {
  test("extracts lowercase tokens from a sentence", () => {
    const tokens = extractWordTokens("Extract this Duplicated logic");
    expect(tokens.has("extract")).toBe(true);
    expect(tokens.has("duplicated")).toBe(true);
    expect(tokens.has("Extract")).toBe(false);
  });

  test("returns empty set for empty string", () => {
    const tokens = extractWordTokens("");
    expect(tokens.size).toBe(0);
  });

  test("handles punctuation and special characters", () => {
    const tokens = extractWordTokens("use Array.map() instead of for-loop");
    expect(tokens.has("use")).toBe(true);
    expect(tokens.has("array")).toBe(true);
    expect(tokens.has("map")).toBe(true);
    expect(tokens.has("loop")).toBe(true);
  });
});

describe("jaccardSimilarity", () => {
  test("returns 1 for identical sets", () => {
    const set = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(set, set)).toBe(1);
  });

  test("returns 0 for disjoint sets", () => {
    const left = new Set(["a", "b"]);
    const right = new Set(["c", "d"]);
    expect(jaccardSimilarity(left, right)).toBe(0);
  });

  test("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test("computes correct coefficient for partial overlap", () => {
    const left = new Set(["a", "b", "c"]);
    const right = new Set(["b", "c", "d"]);
    expect(jaccardSimilarity(left, right)).toBeCloseTo(0.5);
  });
});

describe("applyConsensusFilter", () => {
  test("returns empty array for empty input", () => {
    expect(applyConsensusFilter([])).toEqual([]);
  });

  test("returns findings unchanged for a single run", () => {
    const findings = [makeFinding({ line: toLineNumber(10) }), makeFinding({ line: toLineNumber(20) })];
    const result = applyConsensusFilter([findings]);
    expect(result).toHaveLength(2);
  });

  describe("all runs agree", () => {
    test("keeps findings that appear in every run", () => {
      const finding = makeFinding({
        line: toLineNumber(10),
        recommendation: "extract this duplicated logic into a shared helper function",
      });
      const runs = [
        [makeFinding({ ...finding, confidence: toConfidence(0.8) })],
        [makeFinding({ ...finding, confidence: toConfidence(0.9) })],
        [makeFinding({ ...finding, confidence: toConfidence(0.85) })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence as number).toBe(0.9);
    });
  });

  describe("all runs differ", () => {
    test("drops findings that appear in only one run out of five", () => {
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: "rename variable to camelCase" })],
        [makeFinding({ line: toLineNumber(50), recommendation: "extract method for readability" })],
        [makeFinding({ line: toLineNumber(90), recommendation: "add error handling for network calls" })],
        [makeFinding({ line: toLineNumber(130), recommendation: "use const instead of let here" })],
        [makeFinding({ line: toLineNumber(170), recommendation: "split this large function into smaller ones" })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(0);
    });
  });

  describe("threshold boundary", () => {
    test("drops findings at exactly 50% of runs", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation })],
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation })],
        [makeFinding({ line: toLineNumber(50), recommendation: "completely different concern about naming" })],
        [makeFinding({ line: toLineNumber(90), recommendation: "another unrelated observation about types" })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(0);
    });

    test("keeps findings appearing in 3 of 5 runs (above 50%)", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.8) })],
        [makeFinding({ line: toLineNumber(11), recommendation: sharedRecommendation, confidence: toConfidence(0.9) })],
        [makeFinding({ line: toLineNumber(12), recommendation: sharedRecommendation, confidence: toConfidence(0.85) })],
        [makeFinding({ line: toLineNumber(50), recommendation: "unrelated naming concern about variables" })],
        [makeFinding({ line: toLineNumber(90), recommendation: "different observation about error handling" })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence as number).toBe(0.9);
    });

    test("keeps findings appearing in 2 of 3 runs (above 50%)", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.7) })],
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.95) })],
        [makeFinding({ line: toLineNumber(50), recommendation: "completely different naming issue" })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence as number).toBe(0.95);
    });
  });

  describe("clustering by proximity", () => {
    test("clusters findings on nearby lines with similar recommendations", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.8) })],
        [makeFinding({ line: toLineNumber(13), recommendation: sharedRecommendation, confidence: toConfidence(0.9) })],
        [makeFinding({ line: toLineNumber(15), recommendation: sharedRecommendation, confidence: toConfidence(0.85) })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence as number).toBe(0.9);
    });

    test("does not cluster findings more than 5 lines apart", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation })],
        [makeFinding({ line: toLineNumber(16), recommendation: sharedRecommendation })],
        [makeFinding({ line: toLineNumber(22), recommendation: sharedRecommendation })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(0);
    });
  });

  describe("clustering by similarity", () => {
    test("does not cluster findings with low recommendation similarity", () => {
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: "rename variable to camelCase for consistency" })],
        [makeFinding({ line: toLineNumber(10), recommendation: "extract method to reduce complexity here" })],
        [makeFinding({ line: toLineNumber(10), recommendation: "add error handling for null pointer cases" })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(0);
    });
  });

  describe("representative selection", () => {
    test("picks the highest confidence finding from a surviving cluster", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.7) })],
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.95) })],
        [makeFinding({ line: toLineNumber(10), recommendation: sharedRecommendation, confidence: toConfidence(0.8) })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(1);
      expect(result[0]!.confidence as number).toBe(0.95);
    });
  });

  describe("multiple clusters", () => {
    test("keeps multiple independent clusters that each pass threshold", () => {
      const recommendationAlpha = "extract this duplicated logic into a shared helper function";
      const recommendationBeta = "rename this variable to follow project naming conventions";
      const runs = [
        [
          makeFinding({ line: toLineNumber(10), recommendation: recommendationAlpha, confidence: toConfidence(0.8) }),
          makeFinding({ line: toLineNumber(50), recommendation: recommendationBeta, confidence: toConfidence(0.7) }),
        ],
        [
          makeFinding({ line: toLineNumber(10), recommendation: recommendationAlpha, confidence: toConfidence(0.9) }),
          makeFinding({ line: toLineNumber(50), recommendation: recommendationBeta, confidence: toConfidence(0.85) }),
        ],
        [
          makeFinding({ line: toLineNumber(10), recommendation: recommendationAlpha, confidence: toConfidence(0.85) }),
          makeFinding({ line: toLineNumber(50), recommendation: recommendationBeta, confidence: toConfidence(0.75) }),
        ],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(2);
      const lines = result.map((finding) => finding.line).sort();
      expect(lines).toEqual([toLineNumber(10), toLineNumber(50)]);
    });
  });

  describe("different files", () => {
    test("does not cluster findings from different files", () => {
      const sharedRecommendation = "extract this duplicated logic into a shared helper function";
      const runs = [
        [makeFinding({ filePath: toFilePath("src/a.ts"), line: toLineNumber(10), recommendation: sharedRecommendation })],
        [makeFinding({ filePath: toFilePath("src/b.ts"), line: toLineNumber(10), recommendation: sharedRecommendation })],
        [makeFinding({ filePath: toFilePath("src/c.ts"), line: toLineNumber(10), recommendation: sharedRecommendation })],
      ];

      const result = applyConsensusFilter(runs);
      expect(result).toHaveLength(0);
    });
  });
});
