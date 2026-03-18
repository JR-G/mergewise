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

import { prepareFindingDelivery } from "./index";

describe("finding delivery preparation", () => {
  const baseFinding = {
    installationId: toInstallationId(1),
    repo: toRepoFullName("acme/widget"),
    prNumber: toPRNumber(3),
    language: "typescript",
    category: "safety" as const,
    status: "posted" as const,
  };

  test("prepareFindingDelivery deduplicates by stable key and applies bounded cap", () => {
    const findings = [
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: toRuleId("rule/a"),
        filePath: toFilePath("src/a.ts"),
        line: toLineNumber(1),
        evidence: "const a: any = source;",
        recommendation: "Use a typed value instead of explicit any annotation.",
        confidence: toConfidence(0.9),
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: toRuleId("rule/a"),
        filePath: toFilePath("src/a.ts"),
        line: toLineNumber(1),
        evidence: "const a: any = source;",
        recommendation: "Use a typed value instead of explicit any annotation.",
        confidence: toConfidence(0.88),
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: toRuleId("rule/b"),
        filePath: toFilePath("src/b.ts"),
        line: toLineNumber(2),
        evidence: "const b: any = source;",
        recommendation: "Wrap database queries in a transaction to prevent partial writes.",
        confidence: toConfidence(0.87),
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: toRuleId("rule/c"),
        filePath: toFilePath("src/c.ts"),
        line: toLineNumber(3),
        evidence: "const c: any = source;",
        recommendation: "Memoize expensive render calculations to avoid unnecessary re-paints.",
        confidence: toConfidence(0.86),
      },
      {
        ...baseFinding,
        findingId: "below-threshold",
        ruleId: toRuleId("rule/d"),
        filePath: toFilePath("src/d.ts"),
        line: toLineNumber(4),
        evidence: "const d: any = source;",
        recommendation: "Validate user input at the boundary before passing downstream.",
        confidence: toConfidence(0.4),
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
        ruleId: toRuleId("rule/a"),
        filePath: toFilePath("src/a.ts"),
        line: toLineNumber(1),
        evidence: "const a: any = source;",
        recommendation: "Use a typed value instead of explicit any annotation.",
        confidence: toConfidence(0.9),
      },
      {
        ...baseFinding,
        findingId: "same-key",
        ruleId: toRuleId("rule/a"),
        filePath: toFilePath("src/a.ts"),
        line: toLineNumber(1),
        evidence: "const a: any = source;",
        recommendation: "Use a typed value instead of explicit any annotation.",
        confidence: toConfidence(0.88),
      },
      {
        ...baseFinding,
        findingId: "cap-1",
        ruleId: toRuleId("rule/b"),
        filePath: toFilePath("src/b.ts"),
        line: toLineNumber(2),
        evidence: "const b: any = source;",
        recommendation: "Wrap database queries in a transaction to prevent partial writes.",
        confidence: toConfidence(0.87),
      },
      {
        ...baseFinding,
        findingId: "cap-2",
        ruleId: toRuleId("rule/c"),
        filePath: toFilePath("src/c.ts"),
        line: toLineNumber(3),
        evidence: "const c: any = source;",
        recommendation: "Memoize expensive render calculations to avoid unnecessary re-paints.",
        confidence: toConfidence(0.86),
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
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(10),
          evidence: "alpha",
          recommendation: "Wrap database queries in a transaction to prevent partial writes during insert operations.",
          confidence: toConfidence(0.92),
        },
        {
          ...baseFinding,
          findingId: "group-b",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(25),
          evidence: "beta",
          recommendation: "Validate user authentication tokens before performing privileged GraphQL mutations.",
          confidence: toConfidence(0.9),
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
          ruleId: toRuleId("rule/clean"),
          category: "clean",
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "alpha",
          recommendation: "Refactor alpha.",
          confidence: toConfidence(0.95),
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
          ruleId: toRuleId("ts-react/no-non-null-assertion"),
          category: "safety",
          filePath: toFilePath("src/a.ts"),
          line: toLineNumber(1),
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.95),
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
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/index.test.ts"),
          line: toLineNumber(4),
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
        },
        {
          ...baseFinding,
          findingId: "non-test-finding",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/index.ts"),
          line: toLineNumber(20),
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.84),
        },
      ],
      {
        confidenceThreshold: 0.8,
        maxComments: 5,
        testFileConfidenceThreshold: 0.98,
      },
    );

    expect(delivery.comments[0]).toBeDefined();
    expect(delivery.comments[0]!.finding.filePath).toBe(toFilePath("src/index.ts"));
  });

  test("prepareFindingDelivery allows high-confidence test findings when no non-test findings exist", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "test-finding-low",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/index.test.ts"),
          line: toLineNumber(4),
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.9),
        },
        {
          ...baseFinding,
          findingId: "test-finding-high",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/index.spec.ts"),
          line: toLineNumber(8),
          evidence: "expect(other!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
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
    expect(delivery.comments[0]!.finding.filePath as string).toBe("src/index.spec.ts");
  });

  test("prepareFindingDelivery counts test-only threshold band as skipped by confidence", () => {
    const delivery = prepareFindingDelivery(
      [
        {
          ...baseFinding,
          findingId: "test-finding-mid",
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/index.test.ts"),
          line: toLineNumber(3),
          evidence: "expect(value!).toBeTruthy();",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.9),
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
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/__mocks__/api.ts"),
          line: toLineNumber(2),
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
        },
        {
          ...baseFinding,
          findingId: "test-dir-file",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/test/helpers.ts"),
          line: toLineNumber(3),
          evidence: "other!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
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
          ruleId: toRuleId("rule/a"),
          filePath: toFilePath("src/component.test.js"),
          line: toLineNumber(1),
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
        },
        {
          ...baseFinding,
          findingId: "jsx-spec",
          ruleId: toRuleId("rule/b"),
          filePath: toFilePath("src/component.spec.jsx"),
          line: toLineNumber(1),
          evidence: "value!",
          recommendation: "Avoid non-null assertions.",
          confidence: toConfidence(0.99),
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
});
