import { describe, expect, test } from "bun:test";
import type { Finding } from "@mergewise/shared-types";
import {
  toConfidence,
  toFilePath,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
} from "@mergewise/shared-types";
import { criticFindings, parseCriticResponse, splitByVerdicts } from "./critic";
import type { ReviewSignals } from "./signals";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: "test-finding-1",
    installationId: null,
    repo: toRepoFullName("owner/repo"),
    prNumber: toPRNumber(1),
    language: "typescript",
    ruleId: toRuleId("llm/reviewer"),
    category: "clean",
    filePath: toFilePath("src/index.ts"),
    line: toLineNumber(10),
    evidence: "function processOrder",
    recommendation: "Extract side effects into a separate function.",
    confidence: toConfidence(0.9),
    status: "posted",
    ...overrides,
  };
}

function makeReviewSignals(overrides: Partial<ReviewSignals> = {}): ReviewSignals {
  return {
    hasInlineProviderValue: false,
    hasValidationMixedWithStateUpdates: false,
    hasRepeatedForwardedProp: false,
    forwardedPropName: null,
    hasStaticConfigTable: false,
    hasParameterMutation: false,
    ...overrides,
  };
}

describe("parseCriticResponse", () => {
  test("parses valid verdicts", () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, keep: true, reason: "Real structural issue" },
        { index: 1, keep: false, reason: "Generic advice" },
      ],
    });

    const verdicts = parseCriticResponse(raw, 2);
    expect(verdicts.length).toBe(2);
    expect(verdicts[0]!.keep).toBe(true);
    expect(verdicts[1]!.keep).toBe(false);
  });

  test("returns all-keep on invalid JSON", () => {
    const verdicts = parseCriticResponse("not json{{{", 3);
    expect(verdicts.length).toBe(3);
    for (const verdict of verdicts) {
      expect(verdict.keep).toBe(true);
    }
  });

  test("skips entries with out-of-range indices", () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, keep: false, reason: "Valid" },
        { index: 99, keep: false, reason: "Out of range" },
        { index: -1, keep: false, reason: "Negative" },
      ],
    });

    const verdicts = parseCriticResponse(raw, 2);
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.index).toBe(0);
  });

  test("defaults missing keep to true", () => {
    const raw = JSON.stringify({
      verdicts: [{ index: 0, reason: "No keep field" }],
    });

    const verdicts = parseCriticResponse(raw, 1);
    expect(verdicts[0]!.keep).toBe(true);
  });

  test("defaults missing reason to fallback text", () => {
    const raw = JSON.stringify({
      verdicts: [{ index: 0, keep: false }],
    });

    const verdicts = parseCriticResponse(raw, 1);
    expect(verdicts[0]!.reason).toBe("No reason provided");
  });

  test("returns empty verdicts when verdicts key is missing", () => {
    const raw = JSON.stringify({ other: "data" });
    const verdicts = parseCriticResponse(raw, 2);
    expect(verdicts.length).toBe(0);
  });
});

describe("splitByVerdicts", () => {
  const findings = [
    makeFinding({ findingId: "f1", line: toLineNumber(10) }),
    makeFinding({ findingId: "f2", line: toLineNumber(20) }),
    makeFinding({ findingId: "f3", line: toLineNumber(30) }),
  ];

  test("keeps all findings when all verdicts say keep", () => {
    const verdicts = [
      { index: 0, keep: true, reason: "Good" },
      { index: 1, keep: true, reason: "Good" },
      { index: 2, keep: true, reason: "Good" },
    ];

    const result = splitByVerdicts(findings, verdicts);
    expect(result.findings.length).toBe(3);
    expect(result.filtered.length).toBe(0);
  });

  test("filters findings when verdicts say discard", () => {
    const verdicts = [
      { index: 0, keep: true, reason: "Real issue" },
      { index: 1, keep: false, reason: "Generic advice" },
      { index: 2, keep: false, reason: "Style nit" },
    ];

    const result = splitByVerdicts(findings, verdicts);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.findingId).toBe("f1");
    expect(result.filtered.length).toBe(2);
    expect(result.filtered[0]!.reason).toBe("Generic advice");
  });

  test("defaults to keep when verdict is missing for an index", () => {
    const verdicts = [{ index: 1, keep: false, reason: "Bad" }];

    const result = splitByVerdicts(findings, verdicts);
    expect(result.findings.length).toBe(2);
    expect(result.filtered.length).toBe(1);
    expect(result.filtered[0]!.finding.findingId).toBe("f2");
  });

  test("handles empty findings", () => {
    const result = splitByVerdicts([], []);
    expect(result.findings).toEqual([]);
    expect(result.filtered).toEqual([]);
  });

  test("handles empty verdicts — keeps everything", () => {
    const result = splitByVerdicts(findings, []);
    expect(result.findings.length).toBe(3);
    expect(result.filtered.length).toBe(0);
  });

  test("collapses repeated dependency-inversion comments into one finding", () => {
    const dependencyFindings = [
      makeFinding({
        findingId: "dep-1",
        line: toLineNumber(15),
        evidence: "const prisma = new PrismaClient();",
        recommendation: "Directly instantiating PrismaClient hardcodes a concrete dependency. Inject the dependency instead.",
      }),
      makeFinding({
        findingId: "dep-2",
        line: toLineNumber(24),
        evidence: "const s3 = new S3Client({ region: \"eu-west-1\" });",
        recommendation: "Directly instantiating S3Client hardcodes a concrete dependency. Inject the dependency instead.",
      }),
      makeFinding({
        findingId: "dep-3",
        line: toLineNumber(30),
        evidence: "const transport = nodemailer.createTransport(...);",
        recommendation: "This function constructs several concrete infrastructure clients inline. Introduce one abstraction boundary and inject the concrete dependencies instead.",
      }),
    ];

    const result = splitByVerdicts(dependencyFindings, []);
    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.findingId).toBe("dep-3");
    expect(result.filtered.length).toBe(2);
    expect(result.filtered[0]!.reason).toContain("single dependency-inversion finding");
  });
});

describe("criticFindings", () => {
  test("suppresses static-config refactors deterministically before critic call", async () => {
    const findings = [
      makeFinding({
        evidence: "export const ROUTES: readonly RouteDefinition[] = [",
        recommendation: "The static routes array should be grouped by concern instead of staying as a flat list.",
      }),
    ];

    const client = {
      complete: async () => {
        throw new Error("critic should not be called");
      },
    } as const;

    const result = await criticFindings(
      findings,
      new Map(),
      client as never,
      new Map([[toFilePath("src/index.ts"), makeReviewSignals({ hasStaticConfigTable: true })]]),
    );

    expect(result.result.findings).toEqual([]);
    expect(result.result.filtered).toHaveLength(1);
    expect(result.result.filtered[0]!.reason).toContain("config-table refactor");
  });

  test("suppresses prop-drilling findings when repeated forwarding signal is absent", async () => {
    const findings = [
      makeFinding({
        recommendation: "This is prop drilling through intermediate components. Use context instead.",
      }),
    ];

    const client = {
      complete: async () => {
        throw new Error("critic should not be called");
      },
    } as const;

    const result = await criticFindings(
      findings,
      new Map(),
      client as never,
      new Map([[toFilePath("src/index.ts"), makeReviewSignals()]]),
    );

    expect(result.result.findings).toEqual([]);
    expect(result.result.filtered[0]!.reason).toContain("prop-drilling finding");
  });
});
