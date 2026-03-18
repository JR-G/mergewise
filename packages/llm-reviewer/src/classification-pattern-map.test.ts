import { describe, expect, test } from "bun:test";
import { filterPatternsByClassifications } from "./classification-pattern-map";
import type { AntiPattern } from "./anti-pattern-types";
import { ANTI_PATTERNS } from "./anti-patterns";

const makePattern = (id: string, category: AntiPattern["category"] = "clean"): AntiPattern => ({
  id,
  title: `Pattern ${id}`,
  description: `Description for ${id}`,
  category,
  languages: ["typescript"],
  badExample: "bad",
  goodExample: "good",
  principle: "Test",
  detectionHint: "hint",
});

describe("filterPatternsByClassifications", () => {
  test("returns full catalogue when classifications array is empty", () => {
    const result = filterPatternsByClassifications([], ANTI_PATTERNS);

    expect(result).toBe(ANTI_PATTERNS);
  });

  test("returns full catalogue when no classifications match any mapping", () => {
    const patterns = [makePattern("alpha"), makePattern("beta")];
    const result = filterPatternsByClassifications(["unknown-classification-xyz"], patterns);

    expect(result).toBe(patterns);
  });

  test("filters to matching patterns for a known classification", () => {
    const result = filterPatternsByClassifications(["error-handling"], ANTI_PATTERNS);

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(ANTI_PATTERNS.length);
    expect(result.some((pattern) => pattern.id === "implicit-any-in-catch")).toBe(true);
  });

  test("unions patterns from multiple classifications without duplicates", () => {
    const result = filterPatternsByClassifications(
      ["error-handling", "type-safety"],
      ANTI_PATTERNS,
    );

    const ids = result.map((pattern) => pattern.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
    expect(result.some((pattern) => pattern.id === "implicit-any-in-catch")).toBe(true);
    expect(result.some((pattern) => pattern.id === "overly-wide-generic")).toBe(true);
  });

  test("returns full catalogue when matched IDs do not exist in allPatterns", () => {
    const patterns = [makePattern("unrelated-pattern-a"), makePattern("unrelated-pattern-b")];
    const result = filterPatternsByClassifications(["error-handling"], patterns);

    expect(result).toBe(patterns);
  });

  test("returns empty array when allPatterns is empty regardless of classifications", () => {
    const result = filterPatternsByClassifications([], []);

    expect(result).toEqual([]);
  });

  test("god-function-growth maps to god-component and mixed-concerns-component", () => {
    const result = filterPatternsByClassifications(["god-function-growth"], ANTI_PATTERNS);

    expect(result.some((pattern) => pattern.id === "god-component")).toBe(true);
    expect(result.some((pattern) => pattern.id === "mixed-concerns-component")).toBe(true);
  });

  test("new-react-component maps to a broad set of React-related patterns", () => {
    const result = filterPatternsByClassifications(["new-react-component"], ANTI_PATTERNS);

    expect(result.length).toBeGreaterThanOrEqual(8);
    expect(result.some((pattern) => pattern.id === "derived-state-as-use-state")).toBe(true);
    expect(result.some((pattern) => pattern.id === "expensive-computation-in-render")).toBe(true);
  });

  test("filtered result is a strict subset of allPatterns", () => {
    const result = filterPatternsByClassifications(["error-handling"], ANTI_PATTERNS);

    for (const pattern of result) {
      expect(ANTI_PATTERNS.includes(pattern)).toBe(true);
    }
  });

  test("long-parameter-list classification maps to expected pattern IDs", () => {
    const result = filterPatternsByClassifications(["long-parameter-list"], ANTI_PATTERNS);

    expect(result.length).toBeGreaterThan(0);
    expect(result.some((pattern) => pattern.id === "long-parameter-list")).toBe(true);
  });

  test("normalised variant long_parameter_list resolves to same patterns", () => {
    const canonical = filterPatternsByClassifications(["long-parameter-list"], ANTI_PATTERNS);
    const underscored = filterPatternsByClassifications(["long_parameter_list"], ANTI_PATTERNS);

    const canonicalIds = canonical.map((pattern) => pattern.id).sort();
    const underscoredIds = underscored.map((pattern) => pattern.id).sort();
    expect(underscoredIds).toEqual(canonicalIds);
  });

  test("duplicate classifications produce deduplicated pattern IDs", () => {
    const result = filterPatternsByClassifications(
      ["long-parameter-list", "long-parameter-list", "long-parameter-list"],
      ANTI_PATTERNS,
    );

    const ids = result.map((pattern) => pattern.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("mixed known and unknown classifications filters to the known subset", () => {
    const result = filterPatternsByClassifications(
      ["long-parameter-list", "totally-unknown-thing"],
      ANTI_PATTERNS,
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(ANTI_PATTERNS.length);
    expect(result.some((pattern) => pattern.id === "long-parameter-list")).toBe(true);
  });
});
