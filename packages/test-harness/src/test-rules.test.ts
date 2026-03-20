import { describe, test, expect } from "bun:test";

import { toRuleId } from "@mergewise/shared-types";

import { createEchoRule, createFixedFindingsRule } from "./test-rules";

describe("test-rules", () => {
  test("createEchoRule returns a stateless rule", () => {
    const rule = createEchoRule("test/custom-echo");

    expect(rule.kind).toBe("stateless");
    expect(rule.metadata.ruleId).toBe(toRuleId("test/custom-echo"));
    expect(rule.analyse).toBeInstanceOf(Function);
  });

  test("createFixedFindingsRule returns a stateless rule", () => {
    const rule = createFixedFindingsRule([]);

    expect(rule.kind).toBe("stateless");
    expect(rule.metadata.ruleId).toBe(toRuleId("test/fixed-findings"));
  });

  test("createEchoRule with invalid rule ID throws", () => {
    expect(() => createEchoRule("invalid-id-no-slash")).toThrow();
  });

  test("createFixedFindingsRule with empty findings returns empty array", async () => {
    const rule = createFixedFindingsRule([]);

    const result = await rule.analyse(
      {
        pullRequest: { repo: { owner: "test", name: "repo" }, prNumber: 1, installationId: 1 },
        diffs: [],
      } as never,
      {} as never,
    );

    expect(result).toHaveLength(0);
  });
});
