import { describe, expect, it, test } from "bun:test";

import type { Finding } from "@mergewise/shared-types";
import { toConfidence, toFilePath, toInstallationId, toLineNumber, toPRNumber, toRepoFullName, toRuleId } from "@mergewise/shared-types";

import {
  buildPrSummaryComment,
  PR_SUMMARY_CHAR_LIMIT,
  upsertPrSummaryComment,
} from "./index";
import {
  buildBlobUrl,
  buildCategoryBadges,
  compareFindings,
  escapeTableCell,
  extractSuggestionBody,
  extractSuggestionTitle,
  groupFindingsIntoSuggestions,
  truncateRecommendation,
} from "./pr-summary";
import { createFinding, workerFetchOptions } from "./test-helpers";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: "f1",
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(1),
    language: "typescript",
    ruleId: toRuleId("test/rule-1"),
    category: "clean",
    filePath: toFilePath("src/index.ts"),
    line: toLineNumber(10),
    evidence: "const x = 1;",
    recommendation: "Use a descriptive name.",
    confidence: toConfidence(0.9),
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

  it("normalises NaN line to L1", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/index.ts", NaN);
    expect(url).toContain("#L1");
  });

  it("normalises fractional line 1.5 to an integer anchor", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/index.ts", 1.5);
    expect(url).toMatch(/#L1$/);
  });

  it("normalises negative line numbers to L1", () => {
    const url = buildBlobUrl("acme/widget", "abc123", "src/index.ts", -5);
    expect(url).toContain("#L1");
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
    const safety = makeFinding({ category: "safety", filePath: toFilePath("a.ts"), line: toLineNumber(1) });
    const clean = makeFinding({ category: "clean", filePath: toFilePath("a.ts"), line: toLineNumber(1) });

    expect(compareFindings(safety, clean)).toBeLessThan(0);
  });

  it("sorts by file path when categories match", () => {
    const fileA = makeFinding({ filePath: toFilePath("a.ts"), line: toLineNumber(1) });
    const fileB = makeFinding({ filePath: toFilePath("b.ts"), line: toLineNumber(1) });

    expect(compareFindings(fileA, fileB)).toBeLessThan(0);
  });

  it("sorts by line number when category and file match", () => {
    const line10 = makeFinding({ line: toLineNumber(10) });
    const line20 = makeFinding({ line: toLineNumber(20) });

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
      makeFinding({ ruleId: toRuleId("test/r1"), recommendation: "Fix it.", filePath: toFilePath("a.ts") }),
      makeFinding({ ruleId: toRuleId("test/r1"), recommendation: "Fix it.", filePath: toFilePath("b.ts") }),
    ];
    const groups = groupFindingsIntoSuggestions(findings);
    expect(groups.length).toBe(1);
    expect(groups[0]!.findings.length).toBe(2);
  });

  it("separates findings with different recommendations into distinct groups", () => {
    const findings = [
      makeFinding({ ruleId: toRuleId("test/r1"), recommendation: "Fix A." }),
      makeFinding({ ruleId: toRuleId("test/r1"), recommendation: "Fix B." }),
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
  const defaultInput = {
    filePaths: ["src/index.ts", "src/app.ts"],
    findings: [] as Finding[],
    repositoryFullName: "acme/widget",
    headSha: "abc123",
    rulesRan: 5,
    rulesPassed: 5,
  };

  test("includes hidden marker in output", () => {
    const body = buildPrSummaryComment({ ...defaultInput, filePaths: [] });
    expect(body).toContain("<!-- mergewise-summary -->");
  });

  test("header counts themed groups not individual findings", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("a.ts"), line: toLineNumber(10), recommendation: "Avoid non-null" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("a.ts"), line: toLineNumber(20), recommendation: "Avoid non-null" },
      { ...createFinding("f3", 0.85, "perf"), ruleId: toRuleId("test/cache"), filePath: toFilePath("b.ts"), line: toLineNumber(5), recommendation: "Cache result" },
    ];
    const body = buildPrSummaryComment({
      ...defaultInput,
      filePaths: ["a.ts", "b.ts", "c.ts"],
      findings,
    });
    expect(body).toContain("**Mergewise**");
    expect(body).toContain("Reviewed 3 files");
    expect(body).toContain("2 suggestions");
  });

  test("renders each suggestion group as a collapsible details block", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), ruleId: toRuleId("test/r1"), filePath: toFilePath("src/app.ts"), line: toLineNumber(10), recommendation: "Fix null. Use a type guard instead." },
      { ...createFinding("f2", 0.85, "perf"), ruleId: toRuleId("test/r2"), filePath: toFilePath("src/utils.ts"), line: toLineNumber(25), recommendation: "Cache result. Avoid recomputing on each render." },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("<details>");
    expect(body).toContain("<strong>Fix null</strong>");
    expect(body).toContain("<strong>Cache result</strong>");
    expect(body).toContain("\u{1F534}");
    expect(body).toContain("\u{1F7E1}");
    expect(body).toContain("src/app.ts");
    expect(body).toContain("src/utils.ts");
    expect(body).toContain("https://github.com/acme/widget/blob/abc123/src/app.ts#L10");
  });

  test("groups findings with same ruleId and recommendation into one suggestion", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("a.ts"), line: toLineNumber(10), recommendation: "Avoid non-null" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("a.ts"), line: toLineNumber(20), recommendation: "Avoid non-null" },
      { ...createFinding("f3", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("b.ts"), line: toLineNumber(5), recommendation: "Avoid non-null" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("1 suggestion");
    expect(body).toContain("3 locations");
    expect(body).toContain("| `a.ts` | [10]");
    expect(body).toContain("[20]");
    expect(body).toContain("| `b.ts` | [5]");
  });

  test("renders recommendation as a blockquote", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), recommendation: "Avoid non-null assertions. Use a type guard instead." },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("> Avoid non-null assertions.");
    expect(body).toContain("> Use a type guard instead.");
  });

  test("overflows locations beyond file limit with sub-text", () => {
    const findings: Finding[] = Array.from({ length: 7 }, (_, index) => ({
      ...createFinding(`f${String(index)}`, 0.9, "safety"),
      ruleId: toRuleId("test/no-bang"),
      filePath: toFilePath(`src/file${String(index)}.ts`),
      line: toLineNumber((index + 1) * 10),
      recommendation: "Avoid non-null assertions",
    }));
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("7 locations");
    expect(body).toContain("src/file0.ts");
    expect(body).toContain("src/file4.ts");
    expect(body).toMatch(/<sub>and \d+ more location/);
  });

  test("sorts suggestion groups by severity", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.8, "clean"), ruleId: toRuleId("test/r-clean"), filePath: toFilePath("src/z.ts"), line: toLineNumber(1), recommendation: "Clean up" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: toRuleId("test/r-safety"), filePath: toFilePath("src/a.ts"), line: toLineNumber(5), recommendation: "Fix null" },
      { ...createFinding("f3", 0.85, "perf"), ruleId: toRuleId("test/r-perf"), filePath: toFilePath("src/b.ts"), line: toLineNumber(3), recommendation: "Cache it" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    const safetyIdx = body.indexOf("Fix null");
    const perfIdx = body.indexOf("Cache it");
    const cleanIdx = body.indexOf("Clean up");
    expect(safetyIdx).toBeLessThan(perfIdx);
    expect(perfIdx).toBeLessThan(cleanIdx);
  });

  test("shows no-issues message when no findings exist", () => {
    const body = buildPrSummaryComment(defaultInput);
    expect(body).toContain("No issues found");
    expect(body).not.toContain("<strong>");
  });

  test("renders files reviewed inside collapsed review details section", () => {
    const body = buildPrSummaryComment(defaultInput);
    expect(body).toContain("<details>");
    expect(body).toContain("Review details");
    expect(body).toContain("`src/app.ts`");
    expect(body).toContain("`src/index.ts`");
  });

  test("uses singular for one file and one suggestion group", () => {
    const findings: Finding[] = [createFinding("f1", 0.9, "clean")];
    const body = buildPrSummaryComment({
      ...defaultInput,
      filePaths: ["src/a.ts"],
      findings,
    });
    expect(body).toContain("1 file");
    expect(body).toContain("1 suggestion");
    expect(body).not.toContain("files");
    expect(body).not.toContain("suggestions");
  });

  test("escapes pipes and newlines in recommendation blockquote", () => {
    const findings: Finding[] = [
      {
        ...createFinding("f1", 0.9, "safety"),
        recommendation: "Use A | B instead\nof C",
      },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("Use A \\| B instead of C");
  });

  test("does not render delivery counters in review details", () => {
    const body = buildPrSummaryComment({
      ...defaultInput,
      deliveryCounters: {
        skippedByConfidence: 3,
        skippedByDeduplication: 1,
        skippedByPolicy: 0,
        skippedByGrouping: 2,
        skippedBySimilarity: 0,
        skippedByCap: 0,
      },
    });
    expect(body).toContain("Review details");
    expect(body).not.toContain("Skipped by confidence");
    expect(body).not.toContain("Delivery");
  });

  test("does not use markdown headers", () => {
    const findings: Finding[] = [createFinding("f1", 0.9, "safety")];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).not.toMatch(/^##+ /m);
  });

  test("uses inline format for single-location suggestions", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), filePath: toFilePath("src/app.ts"), line: toLineNumber(10), recommendation: "Fix null" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("`src/app.ts`");
    expect(body).toContain("[10]");
    expect(body).toContain("1 location");
    expect(body).not.toContain("| File | Lines |");
  });

  test("uses table format for multi-location suggestions", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("a.ts"), line: toLineNumber(10), recommendation: "Avoid" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: toRuleId("test/no-bang"), filePath: toFilePath("b.ts"), line: toLineNumber(20), recommendation: "Avoid" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("| File | Lines |");
    expect(body).toContain("| `a.ts` |");
    expect(body).toContain("| `b.ts` |");
  });

  test("splits findings with different recommendations into separate groups", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "idiomatic"), ruleId: toRuleId("llm/reviewer"), filePath: toFilePath("a.ts"), line: toLineNumber(10), recommendation: "God component detected" },
      { ...createFinding("f2", 0.9, "idiomatic"), ruleId: toRuleId("llm/reviewer"), filePath: toFilePath("b.ts"), line: toLineNumber(20), recommendation: "Prop drilling detected" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("2 suggestions");
    expect(body).toContain("God component detected");
    expect(body).toContain("Prop drilling detected");
  });

  test("truncates suggestion blocks when output exceeds character limit", () => {
    const findings: Finding[] = Array.from({ length: 50 }, (_, index) => ({
      ...createFinding(`f${String(index)}`, 0.9 - index * 0.001, "safety"),
      ruleId: toRuleId(`test/r-safety-${String(index)}`),
      filePath: toFilePath(`src/components/very-long-directory-name/deeply-nested-file-${String(index)}.ts`),
      line: toLineNumber((index + 1) * 10),
      recommendation: "This is a long recommendation that describes the issue in great detail and adds to the total character count of the summary comment body",
    }));
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body.length).toBeLessThanOrEqual(PR_SUMMARY_CHAR_LIMIT);
    expect(body).toContain("**Mergewise**");
    expect(body).toContain("Review details");
    expect(body).toMatch(/<sub>and \d+ more suggestion/);
  });

  test("preserves header and review details when truncating", () => {
    const findings: Finding[] = Array.from({ length: 40 }, (_, index) => ({
      ...createFinding(`f${String(index)}`, 0.9, "safety"),
      ruleId: toRuleId(`test/r-safety-${String(index)}`),
      filePath: toFilePath(`src/components/deep-nested-directory/module-${String(index)}.ts`),
      line: toLineNumber((index + 1) * 10),
      recommendation: "Refactor this function to reduce cyclomatic complexity and improve maintainability of the codebase",
    }));
    const body = buildPrSummaryComment({
      ...defaultInput,
      filePaths: ["src/a.ts", "src/b.ts"],
      findings,
      rulesRan: 10,
      rulesPassed: 8,
    });
    expect(body).toContain("<!-- mergewise-summary -->");
    expect(body).toContain("8/10 passed");
  });

  test("does not truncate when output is within character limit", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), recommendation: "Fix null" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body.length).toBeLessThan(PR_SUMMARY_CHAR_LIMIT);
    expect(body).toContain("Fix null");
    expect(body).not.toContain("more suggestion");
  });

  test("renders full recommendation text in blockquote without truncation", () => {
    const longRecommendation = "Avoid non-null assertions. " + "A".repeat(100) + " end of text.";
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), recommendation: longRecommendation },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("end of text.");
  });
});

describe("upsertPrSummaryComment", () => {
  test("creates a new comment when no existing summary comment is found", async () => {
    let postedBody = "";
    const result = await upsertPrSummaryComment(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 50,
        installationAccessToken: "ghs_token",
        body: "<!-- mergewise-summary -->\n## Summary",
        traceId: "trace-1",
        githubFetchOptions: workerFetchOptions,
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        postPullRequestSummaryCommentFn: async (opts) => {
          postedBody = opts.body;
          return { id: 100, node_id: "IC_100", html_url: "", body: opts.body };
        },
        updateIssueCommentFn: async () => {
          throw new Error("should not be called");
        },
        logInfo: () => {},
      },
    );

    expect(result.id).toBe(100);
    expect(postedBody).toContain("<!-- mergewise-summary -->");
  });

  test("updates existing comment when marker is found", async () => {
    let updatedCommentId: number | undefined;
    let updatedBody = "";
    const result = await upsertPrSummaryComment(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 50,
        installationAccessToken: "ghs_token",
        body: "<!-- mergewise-summary -->\n## Updated",
        traceId: "trace-2",
        githubFetchOptions: workerFetchOptions,
      },
      {
        listPullRequestSummaryCommentsFn: async () => [
          {
            id: 200,
            node_id: "IC_200",
            html_url: "",
            body: "<!-- mergewise-summary -->\n## Old summary",
          },
        ],
        postPullRequestSummaryCommentFn: async () => {
          throw new Error("should not be called");
        },
        updateIssueCommentFn: async (opts) => {
          updatedCommentId = opts.commentId;
          updatedBody = opts.body;
          return { id: opts.commentId, node_id: "IC_200", html_url: "", body: opts.body };
        },
        logInfo: () => {},
      },
    );

    expect(result.id).toBe(200);
    expect(updatedCommentId).toBe(200);
    expect(updatedBody).toContain("## Updated");
  });

  test("ignores comments without the marker", async () => {
    let postedBody = "";
    await upsertPrSummaryComment(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 50,
        installationAccessToken: "ghs_token",
        body: "<!-- mergewise-summary -->\n## Summary",
        traceId: "trace-3",
        githubFetchOptions: workerFetchOptions,
      },
      {
        listPullRequestSummaryCommentsFn: async () => [
          { id: 300, node_id: "IC_300", html_url: "", body: "Just a normal comment" },
        ],
        postPullRequestSummaryCommentFn: async (opts) => {
          postedBody = opts.body;
          return { id: 301, node_id: "IC_301", html_url: "", body: opts.body };
        },
        updateIssueCommentFn: async () => {
          throw new Error("should not be called");
        },
        logInfo: () => {},
      },
    );

    expect(postedBody).toContain("<!-- mergewise-summary -->");
  });
});
