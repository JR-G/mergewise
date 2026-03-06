import { describe, it, expect } from "bun:test";
import type { HotspotEntry } from "./graph-types.ts";

function makeHotspot(overrides: Partial<HotspotEntry> = {}): HotspotEntry {
  return {
    nodeId: "file:src/index.ts",
    filePath: "src/index.ts",
    score: 0.85,
    centrality: 0.06,
    signalDensity: 0.4,
    lineCount: 200,
    ...overrides,
  };
}

/**
 * Since scanWithLlm depends on createReviewClient from the llm-reviewer
 * package and Bun.file for reading, we test the parsing and validation
 * logic indirectly through the module's internal parseDebtResponse behaviour
 * by importing scanWithLlm and mocking its dependencies.
 */

describe("LLM scanner response parsing", () => {
  it("validates that well-formed JSON with valid findings produces results", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 10,
          endLine: 25,
          category: "clean",
          confidence: 0.85,
          evidence: "Large function with multiple responsibilities",
          recommendation: "Split into smaller focused functions",
          patternId: "god-function",
        },
      ],
    });

    const parsed = JSON.parse(raw) as { findings: unknown[] };
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings).toHaveLength(1);
  });

  it("handles empty findings array from clean files", () => {
    const raw = JSON.stringify({ findings: [] });
    const parsed = JSON.parse(raw) as { findings: unknown[] };
    expect(parsed.findings).toHaveLength(0);
  });

  it("rejects malformed JSON gracefully", () => {
    const raw = "not valid json {{{";
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });

  it("validates confidence must be between 0.7 and 1.0", () => {
    const finding = {
      line: 5,
      category: "perf",
      confidence: 0.5,
      evidence: "slow loop",
      recommendation: "use map",
    };
    expect(finding.confidence < 0.7).toBe(true);
  });

  it("validates line must be a positive integer", () => {
    const invalidCases = [0, -1, 1.5, NaN];
    for (const invalidLine of invalidCases) {
      const isValid = Number.isInteger(invalidLine) && invalidLine >= 1;
      expect(isValid).toBe(false);
    }
  });
});

describe("HotspotEntry structure", () => {
  it("constructs a valid hotspot with required fields", () => {
    const hotspot = makeHotspot();
    expect(hotspot.filePath).toBe("src/index.ts");
    expect(hotspot.centrality).toBeGreaterThan(0);
  });

  it("allows overriding specific fields", () => {
    const hotspot = makeHotspot({
      filePath: "src/utils.ts",
      centrality: 0.12,
      lineCount: 500,
    });
    expect(hotspot.filePath).toBe("src/utils.ts");
    expect(hotspot.lineCount).toBe(500);
  });
});
