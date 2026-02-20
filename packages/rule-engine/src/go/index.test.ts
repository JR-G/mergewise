import { describe, expect, test } from "bun:test";

import type { AnalysisContext } from "@mergewise/shared-types";

import { executeRules } from "../index";
import { goFmtPrintRule, goPilotRules } from "./index";

function createAnalysisContextWithGoDiff(diffLines: readonly string[]): AnalysisContext {
  return {
    diffs: [
      {
        filePath: "internal/service/handler.go",
        previousPath: null,
        hunks: [
          {
            header: "@@ -8,1 +8,4 @@",
            lines: diffLines,
          },
        ],
      },
    ],
    pullRequest: {
      repo: "acme/widget",
      prNumber: 42,
      headSha: "abc123",
      installationId: 9,
    },
  };
}

describe("go pilot rulepack", () => {
  test("exports one deterministic Go pilot rule", () => {
    expect(goPilotRules).toEqual([goFmtPrintRule]);
    expect(goPilotRules).toHaveLength(1);
    expect(goPilotRules[0]?.kind).toBe("stateless");
    expect(goPilotRules[0]?.metadata.ruleId).toBe("go/no-fmt-print");
    expect(goPilotRules[0]?.metadata.languages).toEqual(["go"]);
  });

  test("runs through executeRules and reports fmt.Print usage in added Go lines", async () => {
    const context = createAnalysisContextWithGoDiff([
      " func run() {",
      "+fmt.Printf(\"debug: %s\", value)",
      "+logger.Info(\"kept\")",
      "+}",
    ]);

    const result = await executeRules({
      context,
      rules: goPilotRules,
    });

    expect(result.failedRuleIds).toEqual([]);
    expect(result.summary.totalRules).toBe(1);
    expect(result.summary.successfulRules).toBe(1);
    expect(result.summary.failedRules).toBe(0);
    expect(result.summary.totalFindings).toBe(1);
    expect(result.summary.findingsByCategory.clean).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.language).toBe("go");
    expect(result.findings[0]?.filePath).toBe("internal/service/handler.go");
    expect(result.findings[0]?.line).toBe(9);
    expect(result.findings[0]?.ruleId).toBe("go/no-fmt-print");
    expect(result.findings[0]?.evidence).toBe("fmt.Printf(\"debug: %s\", value)");
  });

  test("ignores non-Go files and lines without fmt.Print calls", async () => {
    const context: AnalysisContext = {
      diffs: [
        {
          filePath: "src/index.ts",
          previousPath: null,
          hunks: [
            {
              header: "@@ -1,1 +1,2 @@",
              lines: [" const previous = true;", "+console.log(\"debug\")"],
            },
          ],
        },
        {
          filePath: "internal/service/worker.go",
          previousPath: null,
          hunks: [
            {
              header: "@@ -3,1 +3,2 @@",
              lines: [" func run() {}", "+logger.Info(\"ok\")"],
            },
          ],
        },
      ],
      pullRequest: {
        repo: "acme/widget",
        prNumber: 42,
        headSha: "abc123",
        installationId: 9,
      },
    };

    const result = await executeRules({
      context,
      rules: goPilotRules,
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.totalFindings).toBe(0);
    expect(result.summary.failedRules).toBe(0);
  });
});
