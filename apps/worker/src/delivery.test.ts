import { describe, expect, test } from "bun:test";

import type { CreatePullRequestReviewOptions } from "@mergewise/github-client";

import {
  applyFindingGates,
  buildWorkerCheckOutput,
  postPreparedFindingComments,
  prepareFindingDelivery,
} from "./index";
import {
  createExecutionResultWithFindings,
  createFinding,
  workerFetchOptions,
} from "./test-helpers";

describe("applyFindingGates", () => {
  test("drops below-threshold findings and preserves highest-confidence-first ordering", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("finding-below-threshold", 0.49, "clean"),
      createFinding("finding-middle", 0.7, "perf"),
      createFinding("finding-late-high", 0.99, "safety"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0.5,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
      review: { skipPatterns: [] },
      llm: {
        enabled: false,
        model: "gpt-4o",
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "finding-late-high",
      "finding-middle",
    ]);
    expect(gatedResult.summary.totalFindings).toBe(2);
  });

  test("does not apply max-comments truncation inside confidence gating", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("finding-low", 0.8, "clean"),
      createFinding("finding-top", 0.99, "perf"),
      createFinding("finding-mid", 0.95, "safety"),
      createFinding("finding-lower", 0.81, "idiomatic"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
      review: { skipPatterns: [] },
      llm: {
        enabled: false,
        model: "gpt-4o",
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "finding-top",
      "finding-mid",
      "finding-lower",
      "finding-low",
    ]);
    expect(gatedResult.summary.totalFindings).toBe(4);
  });

  test("uses deterministic tie ordering for equal-confidence findings", () => {
    const executionResult = createExecutionResultWithFindings([
      createFinding("z-finding", 0.9, "clean"),
      createFinding("a-finding", 0.9, "perf"),
      createFinding("m-finding", 0.9, "safety"),
    ]);

    const gatedResult = applyFindingGates(executionResult, {
      gating: {
        confidenceThreshold: 0,
        maxComments: 2,
      },
      rules: {
        include: [],
        exclude: [],
      },
      review: { skipPatterns: [] },
      llm: {
        enabled: false,
        model: "gpt-4o",
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "a-finding",
      "m-finding",
      "z-finding",
    ]);
  });
});

describe("finding delivery", () => {
  const baseFinding = {
    installationId: 1,
    repo: "acme/widget",
    prNumber: 3,
    language: "typescript",
    category: "safety" as const,
    status: "posted" as const,
  };

  test("prepareFindingDelivery deduplicates by stable key and applies bounded cap", () => {
    const findings = [
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.9,
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.88,
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: "rule/b",
        filePath: "src/b.ts",
        line: 2,
        evidence: "const b: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.87,
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: "rule/c",
        filePath: "src/c.ts",
        line: 3,
        evidence: "const c: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.86,
      },
      {
        ...baseFinding,
        findingId: "below-threshold",
        ruleId: "rule/d",
        filePath: "src/d.ts",
        line: 4,
        evidence: "const d: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.4,
      },
    ];

    const delivery = prepareFindingDelivery(findings, {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });

    expect(delivery.comments.map((comment) => comment.dedupeKey)).toEqual([
      "acme/widget#3:same-key",
      "acme/widget#3:cap-1",
    ]);
    expect(delivery.comments.some((comment) => comment.dedupeKey === "acme/widget#3:below-threshold")).toBe(false);
    expect(delivery.comments.some((comment) => comment.dedupeKey === "acme/widget#3:cap-2")).toBe(false);
  });

  test("prepareFindingDelivery ordering is deterministic across input permutations", () => {
    const findings = [
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.9,
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: "rule/a",
        filePath: "src/a.ts",
        line: 1,
        evidence: "const a: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.88,
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: "rule/b",
        filePath: "src/b.ts",
        line: 2,
        evidence: "const b: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.87,
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: "rule/c",
        filePath: "src/c.ts",
        line: 3,
        evidence: "const c: any = source;",
        recommendation: "Use a typed value.",
        confidence: 0.86,
      },
    ];

    const forwardOrderDelivery = prepareFindingDelivery(findings, {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });
    const reverseOrderDelivery = prepareFindingDelivery([...findings].reverse(), {
      confidenceThreshold: 0.8,
      maxComments: 2,
    });

    expect(forwardOrderDelivery.comments.map((comment) => comment.dedupeKey)).toEqual([
      "acme/widget#3:same-key",
      "acme/widget#3:cap-1",
    ]);
    expect(reverseOrderDelivery.comments.map((comment) => comment.dedupeKey)).toEqual([
      "acme/widget#3:same-key",
      "acme/widget#3:cap-1",
    ]);
    expect(reverseOrderDelivery).toEqual(forwardOrderDelivery);
  });

  test("prepareFindingDelivery groups same file/rule findings into one comment", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "group-a",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 10,
          evidence: "alpha",
          recommendation: "Refactor alpha.",
          confidence: 0.92,
        },
        {
          ...baseFinding,
          findingId: "group-b",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 25,
          evidence: "beta",
          recommendation: "Refactor beta.",
          confidence: 0.9,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
      },
    );

    expect(delivery.comments[0]).toBeDefined();
    expect(delivery.comments[0]!.groupedFindings.map((finding) => finding.findingId)).toContain("group-a");
    expect(delivery.comments[0]!.groupedFindings.map((finding) => finding.findingId)).toContain("group-b");
    expect(delivery.comments[0]!.body).toContain("Also affects 1 other location");
    expect(delivery.comments[0]!.body).toContain("`src/a.ts:25`");
  });

  test("prepareFindingDelivery includes clean category in default post policy", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "policy-clean",
          ruleId: "rule/clean",
          category: "clean",
          filePath: "src/a.ts",
          line: 1,
          evidence: "alpha",
          recommendation: "Refactor alpha.",
          confidence: 0.95,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
      },
    );

    expect(delivery.comments[0]).toBeDefined();
    expect(delivery.comments[0]!.finding.category).toBe("clean");
  });

  test("prepareFindingDelivery applies default blocked-rule post policy", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "policy-blocked-rule",
          ruleId: "ts-react/no-non-null-assertion",
          category: "safety",
          filePath: "src/a.ts",
          line: 1,
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.95,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
      },
    );

    expect(delivery.comments).toHaveLength(0);
  });

  test("prepareFindingDelivery suppresses test-file findings when non-test findings exist", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "test-finding",
          ruleId: "rule/a",
          filePath: "src/index.test.ts",
          line: 4,
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
        {
          ...baseFinding,
          findingId: "non-test-finding",
          ruleId: "rule/b",
          filePath: "src/index.ts",
          line: 20,
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.84,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 0.98,
      },
    );

    expect(delivery.comments[0]).toBeDefined();
    expect(delivery.comments[0]!.finding.filePath).toBe("src/index.ts");
  });

  test("prepareFindingDelivery allows high-confidence test findings when no non-test findings exist", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "test-finding-low",
          ruleId: "rule/a",
          filePath: "src/index.test.ts",
          line: 4,
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "test-finding-high",
          ruleId: "rule/b",
          filePath: "src/index.spec.ts",
          line: 8,
          evidence: "expect(other!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 0.98,
      },
    );

    expect(delivery.comments[0]).toBeDefined();
    expect(delivery.comments[0]!.finding.findingId).toBe("test-finding-high");
    expect(delivery.comments[0]!.finding.filePath).toBe("src/index.spec.ts");
  });

  test("prepareFindingDelivery counts test-only threshold band as skipped by confidence", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "test-finding-mid",
          ruleId: "rule/a",
          filePath: "src/index.test.ts",
          line: 3,
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.9,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 0.98,
      },
    );

    expect(delivery.comments).toHaveLength(0);
  });

  test("prepareFindingDelivery treats __mocks__ and /test/ paths as test files", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "mock-file",
          ruleId: "rule/a",
          filePath: "src/__mocks__/api.ts",
          line: 2,
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
        {
          ...baseFinding,
          findingId: "test-dir-file",
          ruleId: "rule/b",
          filePath: "src/test/helpers.ts",
          line: 3,
          evidence: "other!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 1,
      },
    );

    expect(delivery.comments).toHaveLength(0);
  });

  test("prepareFindingDelivery treats JavaScript test/spec suffixes as test files", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "js-test",
          ruleId: "rule/a",
          filePath: "src/component.test.js",
          line: 1,
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
        {
          ...baseFinding,
          findingId: "jsx-spec",
          ruleId: "rule/b",
          filePath: "src/component.spec.jsx",
          line: 1,
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: 0.99,
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 1,
      },
    );

    expect(delivery.comments).toHaveLength(0);
  });

  test("postPreparedFindingComments posts bounded payload via batch review", async () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 1,
          evidence: "const b: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.89,
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
    expect(capturedReviewOptions[0]!.comments[0]!.body).toContain("**safety**: Use a typed value.");
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
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 1,
          evidence: "const b: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.89,
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
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 1,
          evidence: "const b: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.89,
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
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const value = ```x```\nnextLine",
          recommendation: "Use a safer pattern.",
          confidence: 0.95,
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
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const value = source;",
          recommendation: "Use safer output.",
          confidence: 0.95,
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
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const value = source;",
          recommendation: "Use safer output.",
          confidence: 0.95,
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

  test("buildWorkerCheckOutput formats reviewer summary grouped by category and rule", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "one",
          ruleId: "rule/a",
          filePath: "src/a.ts",
          line: 1,
          evidence: "const a: any = source;",
          recommendation: "Use a typed value.",
          confidence: 0.9,
        },
        {
          ...baseFinding,
          category: "perf",
          findingId: "two",
          ruleId: "rule/b",
          filePath: "src/b.ts",
          line: 12,
          evidence: "for (const item of items) { expensive(item); }",
          recommendation: "Memoize expensive computation.",
          confidence: 0.88,
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
    expect(checkOutput.summary).toContain("Rules=3/3");
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
    expect(checkOutput.text).toContain("skipped_by_grouping");
  });
});
