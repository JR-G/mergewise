import { describe, expect, test } from "bun:test";

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
  applyFindingGates,
  computeTextSimilarity,
  prepareFindingDelivery,
} from "./index";
import {
  createExecutionResultWithFindings,
  createFinding,
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
      review: { skipPatterns: [], agentFriendliness: false },
      llm: {
        enabled: false,
        model: "gpt-4o",
        triageModel: "gpt-4.1-mini",
        criticModel: "gpt-4.1-mini",
        usePipeline: true,
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
        consistencySamples: 1,
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
      review: { skipPatterns: [], agentFriendliness: false },
      llm: {
        enabled: false,
        model: "gpt-4o",
        triageModel: "gpt-4.1-mini",
        criticModel: "gpt-4.1-mini",
        usePipeline: true,
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
        consistencySamples: 1,
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
      review: { skipPatterns: [], agentFriendliness: false },
      llm: {
        enabled: false,
        model: "gpt-4o",
        triageModel: "gpt-4.1-mini",
        criticModel: "gpt-4.1-mini",
        usePipeline: true,
        tokenBudget: 30_000,
        baseUrl: "https://api.openai.com/v1",
        consistencySamples: 1,
      },
    });

    expect(gatedResult.findings.map((finding) => finding.findingId)).toEqual([
      "a-finding",
      "m-finding",
      "z-finding",
    ]);
  });
});

describe("computeTextSimilarity", () => {
  test("returns 1 for identical texts", () => {
    expect(computeTextSimilarity("extract for SRP", "extract for SRP")).toBe(1);
  });

  test("returns 0 for completely different texts", () => {
    expect(computeTextSimilarity("extract function for SRP", "use memoization for cache")).toBeLessThan(0.3);
  });

  test("returns high similarity for minor phrasing differences", () => {
    const similarity = computeTextSimilarity(
      "Extract this logic into a separate function for Single Responsibility Principle",
      "Extract the logic into a separate function to follow Single Responsibility Principle",
    );
    expect(similarity).toBeGreaterThanOrEqual(0.7);
  });

  test("returns 1 when both texts are empty", () => {
    expect(computeTextSimilarity("", "")).toBe(1);
  });

  test("returns 0 when only one text is empty", () => {
    expect(computeTextSimilarity("extract function", "")).toBe(0);
  });
});

describe("similarity deduplication", () => {
  const baseFinding = {
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(3),
    language: "typescript",
    category: "clean" as const,
    status: "posted" as const,
  };

  test("groups findings with same category and similar recommendations", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "srp-1",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(10),
          evidence: "class A { ... }",
          recommendation: "Extract this logic into a separate function for Single Responsibility Principle",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "srp-2",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(20),
          evidence: "class B { ... }",
          recommendation: "Extract the logic into a separate function to follow Single Responsibility Principle",
          confidence: toConfidence(0.88),
        },
        {
          ...baseFinding,
          findingId: "srp-3",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/c.ts"),
          line: toLineNumber(30),
          evidence: "class C { ... }",
          recommendation: "Extract this code into a separate function for Single Responsibility Principle",
          confidence: toConfidence(0.85),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments).toHaveLength(1);
    expect(delivery.comments[0]!.finding.findingId).toBe("srp-1");
    expect(delivery.skippedBySimilarity).toBe(2);
  });

  test("keeps findings with different categories even if recommendations are similar", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "clean-1",
          ruleId: toRuleId("llm/srp"),
          category: "clean",
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(10),
          evidence: "class A { ... }",
          recommendation: "Extract this logic into a separate function for SRP",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "perf-1",
          ruleId: toRuleId("llm/perf"),
          category: "perf",
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(20),
          evidence: "class B { ... }",
          recommendation: "Extract this logic into a separate function for SRP",
          confidence: toConfidence(0.88),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments).toHaveLength(2);
    expect(delivery.skippedBySimilarity).toBe(0);
  });

  test("keeps the highest-confidence finding from each similarity group", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "low-conf",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(10),
          evidence: "class A { ... }",
          recommendation: "Extract this logic into a separate function for Single Responsibility",
          confidence: toConfidence(0.85),
        },
        {
          ...baseFinding,
          findingId: "high-conf",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(20),
          evidence: "class B { ... }",
          recommendation: "Extract the logic into a separate function for Single Responsibility",
          confidence: toConfidence(0.95),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments).toHaveLength(1);
    expect(delivery.comments[0]!.finding.findingId).toBe("high-conf");
  });

  test("does not group findings with genuinely different recommendations", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "srp-finding",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(10),
          evidence: "class A { ... }",
          recommendation: "Extract this logic into a separate function for Single Responsibility Principle",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "memo-finding",
          ruleId: toRuleId("llm/memo"),
          filePath: toFilePath("src/b.ts"),
          line: toLineNumber(20),
          evidence: "function compute() { ... }",
          recommendation: "Use React.memo or useMemo to avoid expensive re-renders on every parent update",
          confidence: toConfidence(0.88),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments).toHaveLength(2);
    expect(delivery.skippedBySimilarity).toBe(0);
  });
});

describe("same-file similarity deduplication", () => {
  const baseFinding = {
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(3),
    language: "typescript",
    category: "clean" as const,
    status: "posted" as const,
  };

  test("deduplicates near-identical findings in the same file", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "same-file-a",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(10),
          evidence: "function handleSubmit() { validate(); save(); notify(); }",
          recommendation: "Refactor the database query builder to reduce duplication",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "same-file-b",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(30),
          evidence: "function handleSubmit() { validate(); save(); notify(); }",
          recommendation: "Refactor the database connection pooling to reduce overhead",
          confidence: toConfidence(0.85),
        },
        {
          ...baseFinding,
          findingId: "other-file-a",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/service.ts"),
          line: toLineNumber(10),
          evidence: "function processOrder() { ... }",
          recommendation: "Simplify the validation pipeline for incoming request payloads",
          confidence: toConfidence(0.91),
        },
        {
          ...baseFinding,
          findingId: "other-file-b",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/utils.ts"),
          line: toLineNumber(20),
          evidence: "function fetchData() { ... }",
          recommendation: "Simplify the sanitisation pipeline for incoming user submissions",
          confidence: toConfidence(0.88),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments.some((comment) => comment.finding.findingId === "same-file-a")).toBe(true);
    expect(delivery.comments.some((comment) => comment.finding.findingId === "same-file-b")).toBe(false);
    expect(delivery.comments.some((comment) => comment.finding.findingId === "other-file-a")).toBe(true);
    expect(delivery.comments.some((comment) => comment.finding.findingId === "other-file-b")).toBe(true);
    expect(delivery.skippedBySimilarity).toBeGreaterThanOrEqual(1);
  });

  test("keeps findings in the same file with genuinely different recommendations", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "srp-finding",
          ruleId: toRuleId("llm/srp"),
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(10),
          evidence: "class A { ... }",
          recommendation: "Extract this logic into a separate function for Single Responsibility Principle",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "memo-finding",
          ruleId: toRuleId("llm/memo"),
          category: "perf",
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(50),
          evidence: "function compute() { ... }",
          recommendation: "Use React.memo or useMemo to avoid expensive re-renders on every parent update",
          confidence: toConfidence(0.88),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments.some((comment) => comment.finding.findingId === "srp-finding")).toBe(true);
    expect(delivery.comments.some((comment) => comment.finding.findingId === "memo-finding")).toBe(true);
    expect(delivery.skippedBySimilarity).toBe(0);
  });

  test("same-file dedup keeps highest-confidence finding from similar pair", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "low-conf-same-file",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(15),
          evidence: "function process() { ... }",
          recommendation: "Simplify the error handling chain to improve readability",
          confidence: toConfidence(0.84),
        },
        {
          ...baseFinding,
          findingId: "high-conf-same-file",
          ruleId: toRuleId("llm/refactor"),
          filePath: toFilePath("src/handler.ts"),
          line: toLineNumber(40),
          evidence: "function process() { ... }",
          recommendation: "Simplify the retry logic chain to improve resilience",
          confidence: toConfidence(0.95),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 10,
      },
    );

    expect(delivery.comments.some((comment) => comment.finding.findingId === "high-conf-same-file")).toBe(true);
    expect(delivery.comments.some((comment) => comment.finding.findingId === "low-conf-same-file")).toBe(false);
  });

  test("skipped_by_cap counts individual findings not groups", () => {
    const distinctRecommendations = [
      "Wrap database queries in a transaction to prevent partial writes during insert operations",
      "Validate user authentication tokens before performing privileged GraphQL mutations",
      "Memoize expensive render calculations using useMemo to avoid unnecessary component re-paints",
      "Replace synchronous file reads with streaming parsers to reduce peak memory consumption",
      "Add rate limiting middleware to public webhook endpoints before deploying to production",
      "Sanitize HTML output with DOMPurify before injecting user-generated content into templates",
      "Use structuredClone instead of JSON parse roundtrip for deep-copying configuration objects",
      "Extract shared validation schemas into a dedicated package to eliminate cross-boundary imports",
    ];
    const findings = distinctRecommendations.map((recommendation, index) => ({
      ...baseFinding,
      findingId: `finding-${String(index)}`,
      ruleId: toRuleId(`rule/${String(index)}`),
      filePath: toFilePath(`src/file-${String(index)}.ts`),
      line: toLineNumber(10),
      evidence: "const value = source;",
      recommendation,
      confidence: toConfidence(0.95 - index * 0.01),
    }));

    const delivery = prepareFindingDelivery(findings, {
      confidenceThreshold: 0.8,
      maxComments: 3,
    });

    expect(delivery.skippedByCap).toBe(5);
  });
});
