import { describe, expect, test } from "bun:test";
import { buildAntiPatternReferenceTable } from "./anti-pattern-table";
import type { AntiPattern } from "./anti-pattern-types";

const makePattern = (overrides: Partial<AntiPattern> = {}): AntiPattern => ({
  id: "test-pattern",
  title: "Test Pattern",
  description: "A test pattern",
  category: "clean",
  languages: ["typescript"],
  badExample: "bad",
  goodExample: "good",
  principle: "Test Principle",
  detectionHint: "Look for test patterns",
  ...overrides,
});

describe("buildAntiPatternReferenceTable", () => {
  test("returns empty string for empty array", () => {
    expect(buildAntiPatternReferenceTable([])).toBe("");
  });

  test("returns markdown table for a single pattern", () => {
    const result = buildAntiPatternReferenceTable([makePattern()]);

    expect(result).toContain("## Anti-pattern reference");
    expect(result).toContain("| id | title | category | principle | detectionHint |");
    expect(result).toContain("| test-pattern | Test Pattern | clean | Test Principle | Look for test patterns |");
  });

  test("includes all patterns in the table", () => {
    const patterns = [
      makePattern({ id: "a", title: "Alpha" }),
      makePattern({ id: "b", title: "Beta" }),
      makePattern({ id: "c", title: "Gamma" }),
    ];

    const result = buildAntiPatternReferenceTable(patterns);

    expect(result).toContain("| a |");
    expect(result).toContain("| b |");
    expect(result).toContain("| c |");
  });

  test("escapes pipe characters in fields", () => {
    const result = buildAntiPatternReferenceTable([
      makePattern({
        title: "Pattern | With Pipes",
        detectionHint: "Look for x | y patterns",
      }),
    ]);

    expect(result).toContain("Pattern \\| With Pipes");
    expect(result).toContain("Look for x \\| y patterns");
    expect(result).not.toContain("| Pattern | With Pipes |");
  });

  test("output is bounded for large inputs", () => {
    const largeArray = Array.from({ length: 100 }, (_, index) =>
      makePattern({ id: `pattern-${index}`, title: `Pattern ${index}` }),
    );

    const result = buildAntiPatternReferenceTable(largeArray);
    const lineCount = result.split("\n").length;

    expect(typeof result).toBe("string");
    expect(lineCount).toBeLessThanOrEqual(110);
  });
});
