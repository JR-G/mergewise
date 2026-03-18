import { describe, it, expect } from "bun:test";
import type { FileDiff, PullRequestMetadata } from "@mergewise/shared-types";
import { toConfidence, toFilePath, toLineNumber, toPRNumber, toRepoFullName, toRuleId, toSHA } from "@mergewise/shared-types";
import {
  extractAddedLineNumbers,
  extractAddedLineMap,
  parseLlmResponse,
  isPlausibleRewrite,
  sanitiseSuggestedRewrite,
  hasEvidenceLineOverlap,
  deduplicateByProximity,
  isCommentLine,
  PRINCIPLE_CATEGORY_MAP,
} from "./schema";
import type { RawLlmFinding, AddedLineInfo } from "./schema";

const STUB_PR: PullRequestMetadata = {
  repo: toRepoFullName("test/repo"),
  prNumber: toPRNumber(1),
  headSha: toSHA("a".repeat(40)),
  installationId: null,
};

function makeDiff(lines: readonly string[], header = "@@ -1,3 +1,5 @@"): FileDiff {
  return {
    filePath: toFilePath("src/index.ts"),
    previousPath: null,
    hunks: [{ header, lines }],
  };
}

describe("extractAddedLineNumbers", () => {
  it("extracts only added line numbers from a hunk", () => {
    const diff = makeDiff([" context", "+added line", "+another added", "-removed"]);
    const added = extractAddedLineNumbers(diff);
    expect(added.has(2)).toBe(true);
    expect(added.has(3)).toBe(true);
    expect(added.size).toBe(2);
  });

  it("returns an empty set for a diff with no additions", () => {
    const diff = makeDiff([" context", "-removed"]);
    const added = extractAddedLineNumbers(diff);
    expect(added.size).toBe(0);
  });

  it("handles empty hunks", () => {
    const diff: FileDiff = { filePath: toFilePath("empty.ts"), previousPath: null, hunks: [] };
    const added = extractAddedLineNumbers(diff);
    expect(added.size).toBe(0);
  });

  it("skips no-newline-at-end markers", () => {
    const diff = makeDiff(["+added", "\\ No newline at end of file"]);
    const added = extractAddedLineNumbers(diff);
    expect(added.size).toBe(1);
  });
});

describe("extractAddedLineMap", () => {
  it("maps line numbers to content and hunk header", () => {
    const diff = makeDiff(["+const x = 1;", " context", "+const y = 2;"]);
    const lineMap = extractAddedLineMap(diff);
    expect(lineMap.get(1)?.content).toBe("const x = 1;");
    expect(lineMap.get(3)?.content).toBe("const y = 2;");
    expect(lineMap.get(1)?.hunkHeader).toBe("@@ -1,3 +1,5 @@");
  });

  it("returns empty map for no additions", () => {
    const diff = makeDiff([" context", "-removed"]);
    expect(extractAddedLineMap(diff).size).toBe(0);
  });
});

describe("parseLlmResponse", () => {
  it("parses valid findings from well-formed JSON", () => {
    const diff = makeDiff(["+const x = fetchData();", "+const y = 2;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "SRP",
          confidence: 0.9,
          evidence: "fetchData call",
          recommendation: "Extract into a helper function",
        },
      ],
    });
    const findings = parseLlmResponse(raw, diff, STUB_PR);
    expect(findings.some((finding) => finding.line === 1)).toBe(true);
    expect(findings.some((finding) => finding.category === "clean")).toBe(true);
    expect(findings.some((finding) => finding.principle === "SRP")).toBe(true);
  });

  it("returns empty array for malformed JSON", () => {
    const diff = makeDiff(["+const x = 1;"]);
    expect(parseLlmResponse("not json", diff, STUB_PR)).toEqual([]);
  });

  it("discards findings referencing lines not in the diff", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 999,
          category: "clean",
          principle: "SRP",
          confidence: 0.9,
          evidence: "phantom line",
          recommendation: "does not exist",
        },
      ],
    });
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("discards findings with invalid category", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "made-up-category",
          principle: "SRP",
          confidence: 0.9,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    });
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("discards findings with missing principle", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    });
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("discards findings with empty principle", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "",
          confidence: 0.9,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    });
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("overrides category when principle maps to a known category", () => {
    const diff = makeDiff(["+const x = fetchData();"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "Derive, don't sync",
          confidence: 0.9,
          evidence: "fetchData call",
          recommendation: "Derive the value directly",
        },
      ],
    });
    const findings = parseLlmResponse(raw, diff, STUB_PR);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("idiomatic");
    expect(findings[0]?.principle).toBe("Derive, don't sync");
  });

  it("preserves model category when principle is unknown", () => {
    const diff = makeDiff(["+const x = fetchData();"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "perf",
          principle: "some-novel-principle",
          confidence: 0.9,
          evidence: "fetchData call",
          recommendation: "Optimise this",
        },
      ],
    });
    const findings = parseLlmResponse(raw, diff, STUB_PR);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe("perf");
    expect(findings[0]?.principle).toBe("some-novel-principle");
  });

  it("discards findings with out-of-range confidence", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "SRP",
          confidence: 1.5,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    });
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("discards findings with NaN confidence", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const rawObject = {
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "SRP",
          confidence: NaN,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    };
    const raw = JSON.stringify(rawObject);
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });

  it("discards findings with Infinity confidence", () => {
    const diff = makeDiff(["+const x = 1;"]);
    const rawObject = {
      findings: [
        {
          line: 1,
          category: "clean",
          principle: "SRP",
          confidence: Infinity,
          evidence: "code",
          recommendation: "fix it",
        },
      ],
    };
    const raw = JSON.stringify(rawObject);
    expect(parseLlmResponse(raw, diff, STUB_PR)).toEqual([]);
  });
});

describe("PRINCIPLE_CATEGORY_MAP", () => {
  it("maps SRP to clean", () => {
    expect(PRINCIPLE_CATEGORY_MAP.get("SRP")).toBe("clean");
  });

  it("maps standard SOLID principles to clean", () => {
    for (const principle of ["DIP", "LSP", "ISP", "OCP"]) {
      expect(PRINCIPLE_CATEGORY_MAP.get(principle)).toBe("clean");
    }
  });

  it("maps catalogue principles to their registered category", () => {
    expect(PRINCIPLE_CATEGORY_MAP.get("Derive, don't sync")).toBe("idiomatic");
    expect(PRINCIPLE_CATEGORY_MAP.get("Memoise expensive derived values")).toBe("perf");
  });

  it("contains entries from the anti-pattern catalogue", () => {
    expect(PRINCIPLE_CATEGORY_MAP.size).toBeGreaterThan(8);
  });
});

describe("isPlausibleRewrite", () => {
  it("returns true when rewrite shares identifiers with original", () => {
    expect(isPlausibleRewrite(
      "const result = fetchData(userId);",
      "const result = await fetchData(userId);",
    )).toBe(true);
  });

  it("returns false for empty rewrite", () => {
    expect(isPlausibleRewrite("const x = 1;", "")).toBe(false);
  });

  it("rejects structural declaration when original is not structural", () => {
    expect(isPlausibleRewrite(
      "const x = getValue();",
      "export class ValueService {}",
    )).toBe(false);
  });

  it("returns false when no identifiers overlap", () => {
    expect(isPlausibleRewrite(
      "const alpha = getBeta();",
      "const gamma = getDelta();",
    )).toBe(false);
  });
});

describe("sanitiseSuggestedRewrite", () => {
  it("preserves rewrite when line is in the diff", () => {
    const finding: RawLlmFinding = {
      line: 1,
      category: "clean",
      principle: "SRP",
      confidence: 0.9,
      evidence: "test",
      recommendation: "fix",
      suggestedRewrite: "const x = 2;",
    };
    const addedLines = new Set([1]);
    const addedLineMap = new Map<number, AddedLineInfo>([
      [1, { content: "const x = 1;", hunkHeader: "@@ -1,1 +1,1 @@" }],
    ]);
    const result = sanitiseSuggestedRewrite(finding, addedLines, addedLineMap);
    expect(result.suggestedRewrite).toBe("const x = 2;");
  });

  it("strips rewrite when line is not in the diff", () => {
    const finding: RawLlmFinding = {
      line: 99,
      category: "clean",
      principle: "SRP",
      confidence: 0.9,
      evidence: "test",
      recommendation: "fix",
      suggestedRewrite: "const x = 2;",
    };
    const result = sanitiseSuggestedRewrite(finding, new Set([1]), new Map());
    expect(result.suggestedRewrite).toBeUndefined();
  });

  it("strips rewrite exceeding 20 lines", () => {
    const longRewrite = Array.from({ length: 21 }, (_, index) => `line ${index}`).join("\n");
    const finding: RawLlmFinding = {
      line: 1,
      category: "clean",
      principle: "SRP",
      confidence: 0.9,
      evidence: "test",
      recommendation: "fix",
      suggestedRewrite: longRewrite,
    };
    const addedLines = new Set([1]);
    const addedLineMap = new Map<number, AddedLineInfo>([
      [1, { content: "const x = 1;", hunkHeader: "@@ -1,1 +1,1 @@" }],
    ]);
    const result = sanitiseSuggestedRewrite(finding, addedLines, addedLineMap);
    expect(result.suggestedRewrite).toBeUndefined();
  });
});

describe("hasEvidenceLineOverlap", () => {
  it("returns true when evidence shares identifiers with line content", () => {
    expect(hasEvidenceLineOverlap("fetchData is called", "const result = fetchData();")).toBe(true);
  });

  it("returns false when no identifiers overlap", () => {
    expect(hasEvidenceLineOverlap("alpha beta gamma", "const delta = epsilon();")).toBe(false);
  });

  it("returns true when either side has no identifiers", () => {
    expect(hasEvidenceLineOverlap("", "const x = 1;")).toBe(true);
  });
});

describe("deduplicateByProximity", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateByProximity([])).toEqual([]);
  });

  it("keeps the highest-confidence finding from a proximity cluster with same principle", () => {
    const base = {
      findingId: "test",
      installationId: null,
      repo: toRepoFullName("test/repo"),
      prNumber: toPRNumber(1),
      language: "typescript" as const,
      ruleId: toRuleId("llm/reviewer"),
      category: "clean" as const,
      principle: "SRP",
      filePath: toFilePath("src/index.ts"),
      evidence: "test",
      recommendation: "fix",
      status: "posted" as const,
    };
    const findings = [
      { ...base, line: toLineNumber(10), confidence: toConfidence(0.7) },
      { ...base, line: toLineNumber(12), confidence: toConfidence(0.95) },
      { ...base, line: toLineNumber(14), confidence: toConfidence(0.8) },
    ];
    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence as number).toBe(0.95);
  });

  it("preserves nearby findings with different principles", () => {
    const base = {
      findingId: "test",
      installationId: null,
      repo: toRepoFullName("test/repo"),
      prNumber: toPRNumber(1),
      language: "typescript" as const,
      ruleId: toRuleId("llm/reviewer"),
      category: "clean" as const,
      filePath: toFilePath("src/index.ts"),
      evidence: "test",
      recommendation: "fix",
      status: "posted" as const,
    };
    const findings = [
      { ...base, principle: "SRP", line: toLineNumber(10), confidence: toConfidence(0.9) },
      { ...base, principle: "DIP", line: toLineNumber(12), confidence: toConfidence(0.85) },
    ];
    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(2);
  });

  it("falls back to category clustering when principle is absent", () => {
    const base = {
      findingId: "test",
      installationId: null,
      repo: toRepoFullName("test/repo"),
      prNumber: toPRNumber(1),
      language: "typescript" as const,
      ruleId: toRuleId("llm/reviewer"),
      category: "clean" as const,
      filePath: toFilePath("src/index.ts"),
      evidence: "test",
      recommendation: "fix",
      status: "posted" as const,
    };
    const findings = [
      { ...base, line: toLineNumber(10), confidence: toConfidence(0.7) },
      { ...base, line: toLineNumber(12), confidence: toConfidence(0.95) },
    ];
    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence as number).toBe(0.95);
  });

  it("caps output at maxFindings", () => {
    const base = {
      findingId: "test",
      installationId: null,
      repo: toRepoFullName("test/repo"),
      prNumber: toPRNumber(1),
      language: "typescript" as const,
      ruleId: toRuleId("llm/reviewer"),
      category: "clean" as const,
      principle: "SRP",
      filePath: toFilePath("src/index.ts"),
      evidence: "test",
      recommendation: "fix",
      status: "posted" as const,
    };
    const findings = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      line: toLineNumber(index * 100 + 1),
      confidence: toConfidence(0.9),
    }));
    const result = deduplicateByProximity(findings, 5, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("isCommentLine", () => {
  it("returns true for single-line comment", () => {
    expect(isCommentLine("  // this is a comment")).toBe(true);
  });

  it("returns true for block comment start", () => {
    expect(isCommentLine("  /* block comment */")).toBe(true);
  });

  it("returns false for code lines", () => {
    expect(isCommentLine("  const x = 1;")).toBe(false);
  });
});
