import { describe, expect, test } from "bun:test";

import type { Finding } from "@mergewise/shared-types";

import {
  buildPrSummaryComment,
  collectCommentFeedback,
  postPreparedFindingComments,
  PR_SUMMARY_CHAR_LIMIT,
  resolveOutdatedComments,
  upsertPrSummaryComment,
  type ExistingCommentState,
} from "./index";
import { createFinding, workerFetchOptions, ZERO_REACTIONS } from "./test-helpers";

describe("resolveOutdatedComments", () => {
  test("resolves threads whose dedupe keys are absent from the new set", async () => {
    const resolvedThreadIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b", "key-c"]),
      dedupeKeyToThreadId: new Map([
        ["key-a", "thread-a"],
        ["key-b", "thread-b"],
        ["key-c", "thread-c"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set(["key-b"]);

    await resolveOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-1",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async (opts) => {
          resolvedThreadIds.push(opts.threadId);
          return { isResolved: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(resolvedThreadIds).toContain("thread-a");
    expect(resolvedThreadIds).toContain("thread-c");
    expect(resolvedThreadIds).not.toContain("thread-b");
  });

  test("skips threads whose dedupe keys are in the new set", async () => {
    const resolvedThreadIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a"]),
      dedupeKeyToThreadId: new Map([["key-a", "thread-a"]]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set(["key-a"]);

    await resolveOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-2",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async (opts) => {
          resolvedThreadIds.push(opts.threadId);
          return { isResolved: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(resolvedThreadIds).toHaveLength(0);
  });

  test("counts per-thread failures and continues processing", async () => {
    let callCount = 0;
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b"]),
      dedupeKeyToThreadId: new Map([
        ["key-a", "thread-a"],
        ["key-b", "thread-b"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set<string>();

    const result = await resolveOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-3",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("GraphQL failure");
          }
          return { isResolved: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.failedCount).toBeGreaterThan(0);
  });

  test("returns zero counts when there are no existing threads", async () => {
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set<string>(),
      dedupeKeyToThreadId: new Map(),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };

    const result = await resolveOutdatedComments(
      existingState,
      new Set(["key-x"]),
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-4",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async () => ({ isResolved: true }),
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.resolvedCount + result.failedCount).toBe(0);
  });

  test("resolves GitHub-outdated threads even when dedupe key matches the new set", async () => {
    const resolvedThreadIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b"]),
      dedupeKeyToThreadId: new Map([
        ["key-a", "thread-a"],
        ["key-b", "thread-b"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(["key-a"]),
    };
    const newKeys = new Set(["key-a", "key-b"]);

    const result = await resolveOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-outdated",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async (opts) => {
          resolvedThreadIds.push(opts.threadId);
          return { isResolved: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(resolvedThreadIds).toContain("thread-a");
    expect(resolvedThreadIds).not.toContain("thread-b");
    expect(result.resolvedOutdatedDedupeKeys).toContain("key-a");
  });

  test("does not return non-outdated resolved keys in resolvedOutdatedDedupeKeys", async () => {
    const resolvedThreadIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-gone", "key-outdated"]),
      dedupeKeyToThreadId: new Map([
        ["key-gone", "thread-gone"],
        ["key-outdated", "thread-outdated"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(["key-outdated"]),
    };
    const newKeys = new Set(["key-outdated"]);

    const result = await resolveOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-mixed",
        githubFetchOptions: workerFetchOptions,
      },
      {
        resolveReviewThreadFn: async (opts) => {
          resolvedThreadIds.push(opts.threadId);
          return { isResolved: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(resolvedThreadIds).toContain("thread-gone");
    expect(resolvedThreadIds).toContain("thread-outdated");
    expect(result.resolvedOutdatedDedupeKeys).toContain("key-outdated");
    expect(result.resolvedOutdatedDedupeKeys.has("key-gone")).toBe(false);
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
      { ...createFinding("f1", 0.9, "safety"), ruleId: "no-bang", filePath: "a.ts", line: 10, recommendation: "Avoid non-null" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: "no-bang", filePath: "a.ts", line: 20, recommendation: "Avoid non-null" },
      { ...createFinding("f3", 0.85, "perf"), ruleId: "cache", filePath: "b.ts", line: 5, recommendation: "Cache result" },
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
      { ...createFinding("f1", 0.9, "safety"), ruleId: "r1", filePath: "src/app.ts", line: 10, recommendation: "Fix null. Use a type guard instead." },
      { ...createFinding("f2", 0.85, "perf"), ruleId: "r2", filePath: "src/utils.ts", line: 25, recommendation: "Cache result. Avoid recomputing on each render." },
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
      { ...createFinding("f1", 0.9, "safety"), ruleId: "no-bang", filePath: "a.ts", line: 10, recommendation: "Avoid non-null" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: "no-bang", filePath: "a.ts", line: 20, recommendation: "Avoid non-null" },
      { ...createFinding("f3", 0.9, "safety"), ruleId: "no-bang", filePath: "b.ts", line: 5, recommendation: "Avoid non-null" },
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
      ruleId: "no-bang",
      filePath: `src/file${String(index)}.ts`,
      line: (index + 1) * 10,
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
      { ...createFinding("f1", 0.8, "clean"), ruleId: "r-clean", filePath: "src/z.ts", line: 1, recommendation: "Clean up" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: "r-safety", filePath: "src/a.ts", line: 5, recommendation: "Fix null" },
      { ...createFinding("f3", 0.85, "perf"), ruleId: "r-perf", filePath: "src/b.ts", line: 3, recommendation: "Cache it" },
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
      { ...createFinding("f1", 0.9, "safety"), filePath: "src/app.ts", line: 10, recommendation: "Fix null" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("`src/app.ts`");
    expect(body).toContain("[10]");
    expect(body).toContain("1 location");
    expect(body).not.toContain("| File | Lines |");
  });

  test("uses table format for multi-location suggestions", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), ruleId: "no-bang", filePath: "a.ts", line: 10, recommendation: "Avoid" },
      { ...createFinding("f2", 0.9, "safety"), ruleId: "no-bang", filePath: "b.ts", line: 20, recommendation: "Avoid" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("| File | Lines |");
    expect(body).toContain("| `a.ts` |");
    expect(body).toContain("| `b.ts` |");
  });

  test("splits findings with different recommendations into separate groups", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "idiomatic"), ruleId: "llm/reviewer", filePath: "a.ts", line: 10, recommendation: "God component detected" },
      { ...createFinding("f2", 0.9, "idiomatic"), ruleId: "llm/reviewer", filePath: "b.ts", line: 20, recommendation: "Prop drilling detected" },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("2 suggestions");
    expect(body).toContain("God component detected");
    expect(body).toContain("Prop drilling detected");
  });

  test("truncates suggestion blocks when output exceeds character limit", () => {
    const findings: Finding[] = Array.from({ length: 50 }, (_, index) => ({
      ...createFinding(`f${String(index)}`, 0.9 - index * 0.001, "safety"),
      ruleId: `r-safety-${String(index)}`,
      filePath: `src/components/very-long-directory-name/deeply-nested-file-${String(index)}.ts`,
      line: (index + 1) * 10,
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
      ruleId: `r-safety-${String(index)}`,
      filePath: `src/components/deep-nested-directory/module-${String(index)}.ts`,
      line: (index + 1) * 10,
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

describe("collectCommentFeedback", () => {
  test("extracts feedback from comments with mergewise-meta and reactions", () => {
    const comments = [
      {
        body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=ts-react/no-any category=safety confidence=0.92 -->",
        reactions: { ...ZERO_REACTIONS, "+1": 3, "-1": 1 },
      },
    ];

    const summary = collectCommentFeedback(comments);

    expect(summary.totalComments).toBeGreaterThan(0);
    expect(summary.withReactions).toBeGreaterThan(0);
    expect(summary.thumbsUp).toBeGreaterThan(0);
    expect(summary.thumbsDown).toBeGreaterThan(0);

    const record = summary.records.find((rec) => rec.findingId === "f1");
    expect(record).toBeDefined();
    expect(record?.ruleId).toBe("ts-react/no-any");
    expect(record?.category).toBe("safety");
    expect(record?.confidence).toBe("0.92");
    expect(record?.thumbsUp).toBeGreaterThan(0);
    expect(record?.thumbsDown).toBeGreaterThan(0);
    expect(record?.otherReactions).toBeGreaterThanOrEqual(0);
  });

  test("skips comments without mergewise-meta", () => {
    const comments = [
      { body: "Just a regular comment", reactions: { ...ZERO_REACTIONS, "+1": 5 } },
      { body: "Another comment without meta" },
    ];

    const summary = collectCommentFeedback(comments);

    expect(summary.totalComments).toBe(0);
    expect(summary.records).toEqual([]);
  });

  test("skips mergewise comments with zero reactions", () => {
    const comments = [
      {
        body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=rule-a category=clean confidence=0.80 -->",
        reactions: ZERO_REACTIONS,
      },
    ];

    const summary = collectCommentFeedback(comments);

    expect(summary.totalComments).toBeGreaterThan(0);
    expect(summary.withReactions).toBe(0);
    expect(summary.records).toEqual([]);
  });

  test("skips mergewise comments without reactions field", () => {
    const comments = [
      {
        body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=rule-a category=clean confidence=0.80 -->",
      },
    ];

    const summary = collectCommentFeedback(comments);

    expect(summary.totalComments).toBeGreaterThan(0);
    expect(summary.withReactions).toBe(0);
    expect(summary.records).toEqual([]);
  });

  test("counts other reaction types separately from thumbs", () => {
    const comments = [
      {
        body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=rule-a category=perf confidence=0.85 -->",
        reactions: { ...ZERO_REACTIONS, "+1": 1, heart: 2, rocket: 3 },
      },
    ];

    const summary = collectCommentFeedback(comments);

    const record = summary.records.find((rec) => rec.findingId === "f1");
    expect(record).toBeDefined();
    expect(record?.thumbsUp).toBeGreaterThan(0);
    expect(record?.thumbsDown).toBe(0);
    expect(record?.otherReactions).toBeGreaterThan(record?.thumbsUp ?? 0);
  });

  test("aggregates totals across multiple reacted comments", () => {
    const comments = [
      {
        body: "<!-- mergewise-meta dedupeKey=k1 findingId=f1 ruleId=rule-a category=safety confidence=0.90 -->",
        reactions: { ...ZERO_REACTIONS, "+1": 2, "-1": 1 },
      },
      {
        body: "<!-- mergewise-meta dedupeKey=k2 findingId=f2 ruleId=rule-b category=clean confidence=0.75 -->",
        reactions: { ...ZERO_REACTIONS, "+1": 1 },
      },
      {
        body: "<!-- mergewise-meta dedupeKey=k3 findingId=f3 ruleId=rule-c category=perf confidence=0.80 -->",
        reactions: ZERO_REACTIONS,
      },
    ];

    const summary = collectCommentFeedback(comments);

    expect(summary.records.some((rec) => rec.findingId === "f1")).toBe(true);
    expect(summary.records.some((rec) => rec.findingId === "f2")).toBe(true);
    expect(summary.records.every((rec) => rec.findingId !== "f3")).toBe(true);
    expect(summary.thumbsUp).toBeGreaterThan(0);
    expect(summary.thumbsDown).toBeGreaterThan(0);
  });
});

describe("postPreparedFindingComments", () => {
  const baseOptions = {
    owner: "acme",
    repository: "widget",
    pullRequestNumber: 50,
    pullRequestHeadSha: "abc123",
    installationAccessToken: "ghs_token",
    traceId: "trace-review",
    githubFetchOptions: workerFetchOptions,
    summaryBody: "2 files reviewed, 0 comments",
  };

  test("skips review submission when there are no inline comments", async () => {
    let reviewCalled = false;

    const result = await postPreparedFindingComments(
      { ...baseOptions, comments: [] },
      {
        existingDedupeKeys: new Set(),
        createPullRequestReviewFn: async () => {
          reviewCalled = true;
          return { id: 1, node_id: "PRR_1", html_url: "", body: "", state: "COMMENTED" };
        },
        logInfo: () => {},
      },
    );

    expect(reviewCalled).toBe(false);
    expect(result.postedCount).toBe(0);
  });

  test("submits review when there are inline comments", async () => {
    let reviewCalled = false;
    const finding = createFinding("f1", 0.9, "safety");

    const result = await postPreparedFindingComments(
      {
        ...baseOptions,
        comments: [
          { dedupeKey: "key-1", finding, groupedFindings: [], body: "Fix this" },
        ],
      },
      {
        existingDedupeKeys: new Set(),
        createPullRequestReviewFn: async () => {
          reviewCalled = true;
          return { id: 1, node_id: "PRR_1", html_url: "", body: "", state: "COMMENTED" };
        },
        logInfo: () => {},
      },
    );

    expect(reviewCalled).toBe(true);
    expect(result.postedCount).toBeGreaterThan(0);
  });
});
