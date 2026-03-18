import { describe, expect, test } from "bun:test";

import type { CreatePullRequestReviewOptions } from "@mergewise/github-client";
import {
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
} from "@mergewise/shared-types";

import {
  buildWorkerCheckOutput,
  postPreparedFindingComments,
  prepareFindingDelivery,
} from "./index";
import { workerFetchOptions } from "./test-helpers";

describe("finding delivery posting", () => {
  const baseFinding = {
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(3),
    language: "typescript",
    category: "safety" as const,
    status: "posted" as const,
  };

  test("postPreparedFindingComments posts bounded payload via batch review", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const a: any = source;",
          recommendation: "Use a typed value instead of explicit any annotation.",
          confidence: toConfidence(0.9),
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(1),
          evidence: "const b: any = source;",
          recommendation: "Wrap database queries in a transaction to prevent partial writes.",
          confidence: toConfidence(0.89),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 1,
      },
    );

    const capturedReviewOptions: CreatePullRequestReviewOptions[] = [];
    const postingResult = await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-post-1",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "1 file reviewed, 1 comment",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async (options) => {
          capturedReviewOptions.push(options);
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
      },
    );

    expect(postingResult.postedCount).toBeGreaterThan(0);
    expect(postingResult.successes[0]).toBeDefined();
    expect(postingResult.failures).toHaveLength(0);
    expect(capturedReviewOptions[0]).toBeDefined();
    expect(capturedReviewOptions[0]!.body).toBe("1 file reviewed, 1 comment");
    expect(capturedReviewOptions[0]!.event).toBe("COMMENT");
    expect(capturedReviewOptions[0]!.comments[0]).toBeDefined();
    expect(capturedReviewOptions[0]!.comments[0]!.body).toContain("**safety**: Use a typed value instead of explicit any annotation.");
    expect(capturedReviewOptions[0]!.comments[0]!.body).toContain("dedupeKey=acme/widget#3:one");
    expect(postingResult.successes[0]!.requestOptions.installationAccessToken).toBe("[REDACTED]");
    expect(postingResult.successes[0]!.requestOptions.traceId).toBe("trace-post-1");
  });

  test("postPreparedFindingComments reports all as failures when batch review fails", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const a: any = source;",
          recommendation: "Use a typed value instead of explicit any annotation.",
          confidence: toConfidence(0.9),
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(1),
          evidence: "const b: any = source;",
          recommendation: "Wrap database queries in a transaction to prevent partial writes.",
          confidence: toConfidence(0.89),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 2,
      },
    );

    const loggedErrors: string[] = [];
    const postingResult = await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-post-2",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "summary",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async () => {
          throw new Error("batch review failed");
        },
        logError: (msg) => loggedErrors.push(msg),
      },
    );

    expect(postingResult.postedCount).toBe(0);
    expect(postingResult.successes).toHaveLength(0);
    expect(postingResult.failures.length).toBeGreaterThan(0);
    expect(postingResult.failures[0]!.errorMessage).toBe("batch review failed");
    expect(postingResult.failures[0]!.requestOptions.installationAccessToken).toBe("[REDACTED]");
    expect(postingResult.failures[0]!.requestOptions.traceId).toBe("trace-post-2");
    expect(loggedErrors.length).toBeGreaterThanOrEqual(1);
    expect(loggedErrors.some((entry) => entry.includes("batch review post failed"))).toBe(true);
  });

  test("postPreparedFindingComments skips already-posted dedupe keys on the pull request", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const a: any = source;",
          recommendation: "Use a typed value instead of explicit any annotation.",
          confidence: toConfidence(0.9),
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(1),
          evidence: "const b: any = source;",
          recommendation: "Wrap database queries in a transaction to prevent partial writes.",
          confidence: toConfidence(0.89),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 2,
      },
    );

    const capturedReviewComments: { body: string }[] = [];
    const postingResult = await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-post-skip-existing",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "summary",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [
          {
            id: 901,
            node_id: "IC_kwDOtest901",
            html_url: "https://github.com/acme/widget/pull/3#issuecomment-901",
            body:
              "<!-- mergewise-meta dedupeKey=acme/widget#3:one " +
              "findingId=one ruleId=rule/a category=clean confidence=0.9 -->",
          },
        ],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async (options) => {
          for (const comment of options.comments) {
            capturedReviewComments.push({ body: comment.body });
          }
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
      },
    );

    expect(postingResult.postedCount).toBeGreaterThan(0);
    expect(postingResult.successes[0]).toBeDefined();
    expect(postingResult.failures).toHaveLength(0);
    expect(postingResult.skipped[0]).toBeDefined();
    expect(postingResult.skipped[0]!.preparedComment.dedupeKey).toBe("acme/widget#3:one");
    expect(capturedReviewComments[0]).toBeDefined();
    expect(capturedReviewComments[0]!.body).toContain("dedupeKey=acme/widget#3:two");
  });

  test("comment body starts with category and recommendation", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "inline-fence",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const value = ```x```\nnextLine",
          recommendation: "Use a safer pattern.",
          confidence: toConfidence(0.95),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 1,
      },
    );

    const capturedCommentBodies: string[] = [];
    await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-inline-fence",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "summary",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async (options) => {
          for (const comment of options.comments) {
            capturedCommentBodies.push(comment.body);
          }
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
      },
    );

    expect(capturedCommentBodies[0]).toBeDefined();
    expect(capturedCommentBodies[0]!).toMatch(/^\*\*safety\*\*: Use a safer pattern\./);
  });

  test("builds suggested rewrite with dynamic markdown fences", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "block-fence",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const value = source;",
          recommendation: "Use safer output.",
          confidence: toConfidence(0.95),
          patchPreview: {
            hunkHeader: "@@ -1,1 +1,1 @@",
            removedLines: ["const value = source;"],
            addedLines: ["const template = \"```\";", "const value = template;"],
          },
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 1,
      },
    );

    const capturedCommentBodies: string[] = [];
    await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-block-fence",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "summary",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async (options) => {
          for (const comment of options.comments) {
            capturedCommentBodies.push(comment.body);
          }
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
      },
    );

    expect(capturedCommentBodies[0]).toBeDefined();
    expect(capturedCommentBodies[0]!).toContain("````typescript");
    expect(capturedCommentBodies[0]!).toContain("\n````\n");
  });

  test("builds GitHub suggested-change block when patch preview is suggestion-safe", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "suggestion-block",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const value = source;",
          recommendation: "Use safer output.",
          confidence: toConfidence(0.95),
          patchPreview: {
            hunkHeader: "@@ -1,1 +1,1 @@",
            removedLines: ["const value = source;"],
            addedLines: ["const value = normalize(source);"],
          },
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 1,
      },
    );

    const capturedCommentBodies: string[] = [];
    await postPreparedFindingComments(
      {
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        pullRequestHeadSha: "abc123",
        installationAccessToken: "token",
        traceId: "trace-suggestion-block",
        githubFetchOptions: workerFetchOptions,
        comments: delivery.comments,
        summaryBody: "summary",
      },
      {
        listPullRequestSummaryCommentsFn: async () => [],
        listPullRequestReviewThreadsFn: async () => [],
        createPullRequestReviewFn: async (options) => {
          for (const comment of options.comments) {
            capturedCommentBodies.push(comment.body);
          }
          return { id: 1, html_url: "https://github.com/x", body: options.body ?? null, state: "commented" };
        },
      },
    );

    expect(capturedCommentBodies[0]).toBeDefined();
    expect(capturedCommentBodies[0]!).toContain("**Suggested change**");
    expect(capturedCommentBodies[0]!).toContain("```suggestion");
  });

  test("buildWorkerCheckOutput handles empty findings without errors", () => {
    const delivery = prepareFindingDelivery([], {
      confidenceThreshold: 0.8,
      maxComments: 20,
    });

    const checkOutput = buildWorkerCheckOutput(
      {
        findings: [],
        summary: {
          totalRules: 0,
          successfulRules: 0,
          failedRules: 0,
          totalFindings: 0,
          findingsByCategory: {
            clean: 0,
            perf: 0,
            safety: 0,
            idiomatic: 0,
          },
        },
        failedRuleIds: [],
      },
      delivery,
      0,
      {
        repositoryFullName: "acme/widget",
        headSha: "abc123",
      },
    );

    expect(checkOutput.title).toBe("Review completed");
    expect(checkOutput.summary).toContain("findings=0");
  });

  test("buildWorkerCheckOutput formats reviewer summary grouped by category and rule", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: toConfidence(0.9),
        },
        {
          ...baseFinding,
          category: "perf",
          findingId: "two",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(12),
          evidence: "for (const item of items) { expensive(item); }",
          recommendation: "Memoize expensive computation.",
          confidence: toConfidence(0.88),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 20,
      },
    );

    const checkOutput = buildWorkerCheckOutput(
      {
        findings: [],
        summary: {
          totalRules: 3,
          successfulRules: 3,
          failedRules: 0,
          totalFindings: 2,
          findingsByCategory: {
            clean: 0,
            perf: 1,
            safety: 1,
            idiomatic: 0,
          },
        },
        failedRuleIds: [],
      },
      delivery,
      0,
      {
        repositoryFullName: "acme/widget",
        headSha: "abc123",
      },
    );

    expect(checkOutput.title).toBe("Review completed");
    expect(checkOutput.summary).toContain("findings=2");
    expect(checkOutput.summary).toContain("posted=0");
    expect(checkOutput.summary).not.toContain("Rules=");
    expect(checkOutput.text).toContain("**Reviewer Summary**");
    expect(checkOutput.text).toContain("- `safety` (1)");
    expect(checkOutput.text).toContain("- `perf` (1)");
    expect(checkOutput.text).toContain("`rule/a` (1)");
    expect(checkOutput.text).toContain("`rule/b` (1)");
    expect(checkOutput.text).toContain(
      "[src/a.ts:1](https://github.com/acme/widget/blob/abc123/src/a.ts#L1)",
    );
    expect(checkOutput.text).toContain(
      "[src/b.ts:12](https://github.com/acme/widget/blob/abc123/src/b.ts#L12)",
    );
    expect(checkOutput.text).toContain("Delivery counters");
    expect(checkOutput.text).toContain("skipped_by_confidence");
    expect(checkOutput.text).toContain("skipped_by_policy");
    expect(checkOutput.text).toContain("skipped_by_similarity");
    expect(checkOutput.text).toContain("skipped_by_grouping");
  });
});
