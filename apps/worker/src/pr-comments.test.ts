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
});

describe("buildPrSummaryComment", () => {
  test("includes hidden marker in output", () => {
    const body = buildPrSummaryComment(0, [], "acme/widget", "abc123");
    expect(body).toContain("<!-- mergewise-summary -->");
  });

  test("shows file and finding counts", () => {
    const findings: Finding[] = [
      createFinding("f1", 0.9, "safety"),
      createFinding("f2", 0.85, "perf"),
    ];
    const body = buildPrSummaryComment(3, findings, "acme/widget", "abc123");
    expect(body).toContain("**3** files reviewed");
    expect(body).toContain("**2** findings");
  });

  test("renders category breakdown table", () => {
    const findings: Finding[] = [
      createFinding("f1", 0.9, "safety"),
      createFinding("f2", 0.85, "safety"),
      createFinding("f3", 0.8, "perf"),
    ];
    const body = buildPrSummaryComment(5, findings, "acme/widget", "abc123");
    expect(body).toContain("| safety | 2 |");
    expect(body).toContain("| perf | 1 |");
    expect(body).not.toContain("| clean |");
  });

  test("renders collapsible findings list with file links", () => {
    const findings: Finding[] = [
      { ...createFinding("f1", 0.9, "safety"), filePath: "src/app.ts", line: 10 },
    ];
    const body = buildPrSummaryComment(1, findings, "acme/widget", "abc123");
    expect(body).toContain("<details>");
    expect(body).toContain("[src/app.ts:10]");
    expect(body).toContain("https://github.com/acme/widget/blob/abc123/src/app.ts#L10");
  });

  test("omits findings section when no findings exist", () => {
    const body = buildPrSummaryComment(2, [], "acme/widget", "abc123");
    expect(body).not.toContain("<details>");
  });

  test("uses singular for one file and one finding", () => {
    const findings: Finding[] = [createFinding("f1", 0.9, "clean")];
    const body = buildPrSummaryComment(1, findings, "acme/widget", "abc123");
    expect(body).toContain("**1** file reviewed");
    expect(body).toContain("**1** finding");
    expect(body).not.toContain("files");
    expect(body).not.toContain("findings");
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
