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
import { parseCriticResponse, splitByVerdicts } from "./critic";

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
});
