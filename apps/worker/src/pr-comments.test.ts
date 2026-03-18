import { describe, expect, test } from "bun:test";

import {
  collectCommentFeedback,
  postPreparedFindingComments,
  resolveOutdatedComments,
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
