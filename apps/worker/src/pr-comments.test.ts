import { describe, expect, test } from "bun:test";

import type { Finding } from "@mergewise/shared-types";

import {
  buildPrSummaryComment,
  collectCommentFeedback,
  minimizeOutdatedComments,
  upsertPrSummaryComment,
  type ExistingCommentState,
} from "./index";
import { createFinding, workerFetchOptions, ZERO_REACTIONS } from "./test-helpers";

describe("minimizeOutdatedComments", () => {
  test("minimises comments whose dedupe keys are absent from the new set", async () => {
    const minimizedNodeIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b", "key-c"]),
      dedupeKeyToNodeId: new Map([
        ["key-a", "node-a"],
        ["key-b", "node-b"],
        ["key-c", "node-c"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set(["key-b"]);

    const result = await minimizeOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-1",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async (opts) => {
          minimizedNodeIds.push(opts.subjectId);
          return { isMinimized: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.minimizedCount).toBe(2);
    expect(result.failedCount).toBe(0);
    expect(minimizedNodeIds).toContain("node-a");
    expect(minimizedNodeIds).toContain("node-c");
    expect(minimizedNodeIds).not.toContain("node-b");
  });

  test("skips comments whose dedupe keys are in the new set", async () => {
    const minimizedNodeIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a"]),
      dedupeKeyToNodeId: new Map([["key-a", "node-a"]]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set(["key-a"]);

    const result = await minimizeOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-2",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async (opts) => {
          minimizedNodeIds.push(opts.subjectId);
          return { isMinimized: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.minimizedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(minimizedNodeIds).toHaveLength(0);
  });

  test("counts per-comment failures and continues processing", async () => {
    let callCount = 0;
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b"]),
      dedupeKeyToNodeId: new Map([
        ["key-a", "node-a"],
        ["key-b", "node-b"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };
    const newKeys = new Set<string>();

    const result = await minimizeOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-3",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async () => {
          callCount += 1;
          if (callCount === 1) {
            throw new Error("GraphQL failure");
          }
          return { isMinimized: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.minimizedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  test("returns zero counts when there are no existing comments", async () => {
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set<string>(),
      dedupeKeyToNodeId: new Map(),
      allComments: [],
      outdatedDedupeKeys: new Set(),
    };

    const result = await minimizeOutdatedComments(
      existingState,
      new Set(["key-x"]),
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-4",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async () => ({ isMinimized: true }),
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(result.minimizedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  test("minimises GitHub-outdated comments even when dedupe key matches the new set", async () => {
    const minimizedNodeIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-a", "key-b"]),
      dedupeKeyToNodeId: new Map([
        ["key-a", "node-a"],
        ["key-b", "node-b"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(["key-a"]),
    };
    const newKeys = new Set(["key-a", "key-b"]);

    const result = await minimizeOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-outdated",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async (opts) => {
          minimizedNodeIds.push(opts.subjectId);
          return { isMinimized: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(minimizedNodeIds).toContain("node-a");
    expect(minimizedNodeIds).not.toContain("node-b");
    expect(result.minimizedOutdatedDedupeKeys).toContain("key-a");
  });

  test("does not return non-outdated minimised keys in minimizedOutdatedDedupeKeys", async () => {
    const minimizedNodeIds: string[] = [];
    const existingState: ExistingCommentState = {
      dedupeKeys: new Set(["key-gone", "key-outdated"]),
      dedupeKeyToNodeId: new Map([
        ["key-gone", "node-gone"],
        ["key-outdated", "node-outdated"],
      ]),
      allComments: [],
      outdatedDedupeKeys: new Set(["key-outdated"]),
    };
    const newKeys = new Set(["key-outdated"]);

    const result = await minimizeOutdatedComments(
      existingState,
      newKeys,
      {
        installationAccessToken: "ghs_token",
        traceId: "trace-mixed",
        githubFetchOptions: workerFetchOptions,
      },
      {
        minimizeCommentFn: async (opts) => {
          minimizedNodeIds.push(opts.subjectId);
          return { isMinimized: true };
        },
        logInfo: () => {},
        logError: () => {},
      },
    );

    expect(minimizedNodeIds).toContain("node-gone");
    expect(minimizedNodeIds).toContain("node-outdated");
    expect(result.minimizedOutdatedDedupeKeys).toContain("key-outdated");
    expect(result.minimizedOutdatedDedupeKeys.has("key-gone")).toBe(false);
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

  test("shows stats line with file count, finding count, and rules", () => {
    const findings: Finding[] = [
      createFinding("f1", 0.9, "safety"),
      createFinding("f2", 0.85, "perf"),
    ];
    const body = buildPrSummaryComment({
      ...defaultInput,
      filePaths: ["a.ts", "b.ts", "c.ts"],
      findings,
    });
    expect(body).toContain("**3** files reviewed");
    expect(body).toContain("**2** findings");
    expect(body).toContain("**5**/5 rules passed");
  });

  test("renders findings as a table with severity emoji and file links", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), filePath: "src/app.ts", line: 10 },
      { ...createFinding("f2", 0.85, "perf"), filePath: "src/utils.ts", line: 25 },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("| Severity | File | Recommendation |");
    expect(body).toContain("🔴 safety");
    expect(body).toContain("🟡 perf");
    expect(body).toContain("[`src/app.ts:10`]");
    expect(body).toContain("https://github.com/acme/widget/blob/abc123/src/app.ts#L10");
  });

  test("sorts findings by severity then file path", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.8, "clean"), filePath: "src/z.ts", line: 1 },
      { ...createFinding("f2", 0.9, "safety"), filePath: "src/a.ts", line: 5 },
      { ...createFinding("f3", 0.85, "perf"), filePath: "src/b.ts", line: 3 },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    const safetyIdx = body.indexOf("🔴 safety");
    const perfIdx = body.indexOf("🟡 perf");
    const cleanIdx = body.indexOf("🔵 clean");
    expect(safetyIdx).toBeLessThan(perfIdx);
    expect(perfIdx).toBeLessThan(cleanIdx);
  });

  test("shows no-issues message and no findings table when no findings exist", () => {
    const body = buildPrSummaryComment(defaultInput);
    expect(body).toContain("✅ No issues found");
    expect(body).not.toContain("| Severity |");
  });

  test("renders collapsible files reviewed section", () => {
    const body = buildPrSummaryComment(defaultInput);
    expect(body).toContain("<details>");
    expect(body).toContain("Files reviewed (2)");
    expect(body).toContain("- `src/app.ts`");
    expect(body).toContain("- `src/index.ts`");
  });

  test("uses singular for one file and one finding", () => {
    const findings: Finding[] = [createFinding("f1", 0.9, "clean")];
    const body = buildPrSummaryComment({
      ...defaultInput,
      filePaths: ["src/a.ts"],
      findings,
    });
    expect(body).toContain("**1** file reviewed");
    expect(body).toContain("**1** finding");
    expect(body).not.toContain("files");
    expect(body).not.toContain("findings");
  });

  test("escapes pipes and newlines in recommendation text", () => {
    const findings: Finding[] = [
      {
        ...createFinding("f1", 0.9, "safety"),
        recommendation: "Use A | B instead\nof C",
      },
    ];
    const body = buildPrSummaryComment({ ...defaultInput, findings });
    expect(body).toContain("Use A \\| B instead of C");
    expect(body).not.toContain("Use A | B");
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
