import { describe, expect, it } from "bun:test";

import type { Finding } from "@mergewise/shared-types";

import {
  PR_SUMMARY_COMMENT_MARKER,
  PR_SUMMARY_CHAR_LIMIT,
  buildBlobUrl,
  buildCategoryBadges,
  buildPrSummaryComment,
  compareFindings,
  escapeTableCell,
  extractSuggestionBody,
  extractSuggestionTitle,
  groupFindingsIntoSuggestions,
  truncateRecommendation,
} from "./pr-summary";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: "f1",
    installationId: 1,
    repo: "acme/widget",
    prNumber: 1,
    language: "typescript",
    ruleId: "rule-1",
    category: "clean",
    filePath: "src/index.ts",
    line: 10,
    evidence: "const x = 1;",
    recommendation: "Use a descriptive name.",
    confidence: 0.9,
    status: "posted",
    ...overrides,
  };
}

describe("escapeTableCell", () => {
  it("escapes pipe characters", () => {
    expect(escapeTableCell("a | b")).toBe("a \\| b");
  });

  it("replaces newlines with spaces", () => {
    expect(escapeTableCell("line one\nline two")).toBe("line one line two");
  });

  it("returns plain text unchanged", () => {
    expect(escapeTableCell("no special chars")).toBe("no special chars");
  });
});

describe("buildBlobUrl", () => {
  it("constructs a GitHub blob permalink with line anchor", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/index.ts", 42);
    expect(url).toContain("https://github.com/acme/widget/blob/abc123/src/index.ts#L42");
  });

  it("normalises line numbers below 1 to L1", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/index.ts", 0);
    expect(url).toContain("#L1");
  });

  it("encodes special characters in file path segments", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/my file.ts", 5);
    expect(url).toContain("src/my%20file.ts");
  });
});

describe("truncateRecommendation", () => {
  it("returns short text unmodified", () => {
    expect(truncateRecommendation("Short text")).toBe("Short text");
  });

  it("truncates and appends ellipsis for long text", () => {
    const longText = "A".repeat(100);
    const result = truncateRecommendation(longText, 20);
    expect(result.length).toBe(20);
    expect(result.endsWith("\u2026")).toBe(true);
  });
});

describe("compareFindings", () => {
  it("sorts safety findings before clean findings", () => {
    const safety = makeFinding({ category: "safety", filePath: "a.ts", line: 1 });
    const clean = makeFinding({ category: "clean", filePath: "a.ts", line: 1 });

    expect(compareFindings(safety, clean)).toBeLessThan(0);
  });

  it("sorts by file path when categories match", () => {
    const fileA = makeFinding({ filePath: "a.ts", line: 1 });
    const fileB = makeFinding({ filePath: "b.ts", line: 1 });

    expect(compareFindings(fileA, fileB)).toBeLessThan(0);
  });

  it("sorts by line number when category and file match", () => {
    const line10 = makeFinding({ line: 10 });
    const line20 = makeFinding({ line: 20 });

    expect(compareFindings(line10, line20)).toBeLessThan(0);
  });
});

describe("buildCategoryBadges", () => {
  it("returns an empty string for zero findings", () => {
    expect(buildCategoryBadges([])).toBe("");
  });

  it("includes badges for present categories in severity order", () => {
    const findings = [
      makeFinding({ category: "clean" }),
      makeFinding({ category: "safety" }),
      makeFinding({ category: "safety" }),
    ];
    const badges = buildCategoryBadges(findings);
    expect(badges).toContain("2");
    expect(badges).toContain("1");
    expect(badges.indexOf("2")).toBeLessThan(badges.indexOf("1"));
  });
});

describe("groupFindingsIntoSuggestions", () => {
  it("groups findings with the same ruleId and recommendation together", () => {
    const findings = [
      makeFinding({ ruleId: "r1", recommendation: "Fix it.", filePath: "a.ts" }),
      makeFinding({ ruleId: "r1", recommendation: "Fix it.", filePath: "b.ts" }),
    ];
    const groups = groupFindingsIntoSuggestions(findings);
    expect(groups.length).toBe(1);
    expect(groups[0]!.findings.length).toBe(2);
  });

  it("separates findings with different recommendations into distinct groups", () => {
    const findings = [
      makeFinding({ ruleId: "r1", recommendation: "Fix A." }),
      makeFinding({ ruleId: "r1", recommendation: "Fix B." }),
    ];
    const groups = groupFindingsIntoSuggestions(findings);
    expect(groups.length).toBe(2);
  });

  it("returns an empty list for empty input", () => {
    expect(groupFindingsIntoSuggestions([]).length).toBe(0);
  });
});

describe("extractSuggestionTitle", () => {
  it("extracts the first sentence before a period-space boundary", () => {
    expect(extractSuggestionTitle("First sentence. Second sentence.")).toBe("First sentence");
  });

  it("strips trailing period from single-sentence text", () => {
    expect(extractSuggestionTitle("Only sentence.")).toBe("Only sentence");
  });

  it("returns full text when no sentence boundary exists", () => {
    expect(extractSuggestionTitle("No period here")).toBe("No period here");
  });
});

describe("extractSuggestionBody", () => {
  it("returns text after the first sentence boundary", () => {
    expect(extractSuggestionBody("Title. Rest of the text.")).toBe("Rest of the text.");
  });

  it("returns empty string for single-sentence input", () => {
    expect(extractSuggestionBody("Only one sentence")).toBe("");
  });
});

describe("buildPrSummaryComment", () => {
  it("includes the summary marker in the output", () => {
    const result = buildPrSummaryComment({
      filePaths: ["src/index.ts"],
      findings: [],
      repositoryFullName: "acme/widget",
      headSha: "abc123",
      rulesRan: 5,
      rulesPassed: 5,
    });

    expect(result).toContain(PR_SUMMARY_COMMENT_MARKER);
  });

  it("shows no-issues message when findings are empty", () => {
    const result = buildPrSummaryComment({
      filePaths: ["src/a.ts", "src/b.ts"],
      findings: [],
      repositoryFullName: "acme/widget",
      headSha: "abc123",
      rulesRan: 3,
      rulesPassed: 3,
    });

    expect(result).toContain("No issues found");
    expect(result).toContain("2 files");
  });

  it("includes suggestion count when findings are present", () => {
    const result = buildPrSummaryComment({
      filePaths: ["src/index.ts"],
      findings: [makeFinding()],
      repositoryFullName: "acme/widget",
      headSha: "abc123",
      rulesRan: 5,
      rulesPassed: 4,
    });

    expect(result).toContain("1 suggestion");
  });

  it("does not exceed the character limit", () => {
    const findings = Array.from({ length: 50 }, (_, index) =>
      makeFinding({
        findingId: `f${String(index)}`,
        filePath: `src/file-${String(index)}.ts`,
        recommendation: "A".repeat(200) + ". " + "B".repeat(200),
      }),
    );

    const result = buildPrSummaryComment({
      filePaths: findings.map((finding) => finding.filePath),
      findings,
      repositoryFullName: "acme/widget",
      headSha: "abc123",
      rulesRan: 10,
      rulesPassed: 10,
    });

    expect(result.length).toBeLessThanOrEqual(PR_SUMMARY_CHAR_LIMIT);
  });
});
