import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  AnalysisContext,
  CodebaseAwareRule,
  CodebaseContext,
  Finding,
  PatchPreview,
  StatelessRule,
} from "@mergewise/shared-types";

import { executeRules } from "./index";

const ANALYSIS_CONTEXT: AnalysisContext = {
  diffs: [],
  pullRequest: {
    repo: "acme/widget",
    prNumber: 42,
    headSha: "abc123",
    installationId: 9,
  },
};

const CODEBASE_CONTEXT: CodebaseContext = {
  symbols: [],
  conventions: new Map<string, string>(),
  readFile: async () => null,
};

function buildFinding(
  ruleId: string,
  category: Finding["category"],
  options?: {
    evidence?: string;
    recommendation?: string;
    patchPreview?: PatchPreview;
    patchSuggestionPolicy?: Finding["patchSuggestionPolicy"];
  },
): Finding {
  return {
    findingId: `${ruleId}-finding`,
    installationId: 9,
    repo: "acme/widget",
    prNumber: 42,
    language: "typescript",
    ruleId,
    category,
    filePath: "src/index.ts",
    line: 1,
    evidence: options?.evidence ?? "const value: any = input;",
    recommendation:
      options?.recommendation ?? "Replace any with a concrete type.",
    patchPreview: options?.patchPreview,
    patchSuggestionPolicy: options?.patchSuggestionPolicy,
    confidence: 0.95,
    status: "posted",
  };
}

describe("executeRules", () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    originalConsoleError = console.error;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test("runs stateless and codebase-aware rules and aggregates summary", async () => {
    const statelessRule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/sample",
        name: "stateless sample",
        category: "safety",
        languages: ["typescript"],
        description: "sample",
      },
      analyse: async () => [buildFinding("stateless/sample", "safety")],
    };
    const codebaseRule: CodebaseAwareRule = {
      kind: "codebase-aware",
      metadata: {
        ruleId: "codebase/sample",
        name: "codebase sample",
        category: "perf",
        languages: ["typescript"],
        description: "sample",
      },
      analyse: async () => [buildFinding("codebase/sample", "perf")],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      codebaseContext: CODEBASE_CONTEXT,
      rules: [statelessRule, codebaseRule],
    });

    expect(result.findings).toHaveLength(2);
    expect(result.failedRuleIds).toEqual([]);
    expect(result.summary.totalRules).toBe(2);
    expect(result.summary.successfulRules).toBe(2);
    expect(result.summary.failedRules).toBe(0);
    expect(result.summary.totalFindings).toBe(2);
    expect(result.summary.findingsByCategory.clean).toBe(0);
    expect(result.summary.findingsByCategory.perf).toBe(1);
    expect(result.summary.findingsByCategory.safety).toBe(1);
    expect(result.summary.findingsByCategory.idiomatic).toBe(0);
    expect(result.findings[0]?.patchSuggestionPolicy).toBe("manual-only");
    expect(result.findings[1]?.patchSuggestionPolicy).toBe("manual-only");
  });

  test("isolates failed rules and invokes error callback", async () => {
    const failureReason = new Error("broken rule");
    const failingRule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/failing",
        name: "failing",
        category: "clean",
        languages: ["typescript"],
        description: "failing",
      },
      analyse: async () => {
        throw failureReason;
      },
    };
    const successfulRule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/success",
        name: "success",
        category: "idiomatic",
        languages: ["typescript"],
        description: "success",
      },
      analyse: async () => [buildFinding("stateless/success", "idiomatic")],
    };

    const capturedErrors: string[] = [];
    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [failingRule, successfulRule],
      onRuleExecutionError: (rule, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        capturedErrors.push(`${rule.metadata.ruleId}:${detail}`);
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.ruleId).toBe("stateless/success");
    expect(result.failedRuleIds).toEqual(["stateless/failing"]);
    expect(result.summary.totalRules).toBe(2);
    expect(result.summary.successfulRules).toBe(1);
    expect(result.summary.failedRules).toBe(1);
    expect(result.summary.totalFindings).toBe(1);
    expect(capturedErrors).toEqual(["stateless/failing:broken rule"]);
  });

  test("fails codebase-aware rule when codebase context is missing", async () => {
    const codebaseRule: CodebaseAwareRule = {
      kind: "codebase-aware",
      metadata: {
        ruleId: "codebase/needs-context",
        name: "needs context",
        category: "perf",
        languages: ["typescript"],
        description: "needs context",
      },
      analyse: async () => [],
    };

    const capturedErrors: string[] = [];
    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [codebaseRule],
      onRuleExecutionError: (rule, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        capturedErrors.push(`${rule.metadata.ruleId}:${detail}`);
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.failedRuleIds).toEqual(["codebase/needs-context"]);
    expect(result.summary.failedRules).toBe(1);
    expect(capturedErrors[0]).toContain("requires codebaseContext");
  });

  test("logs failures with default logger when callback is not provided", async () => {
    const failingRule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/default-log",
        name: "default log",
        category: "clean",
        languages: ["typescript"],
        description: "default log",
      },
      analyse: async () => {
        throw new Error("default logger failure");
      },
    };

    const loggedMessages: string[] = [];
    console.error = (message?: unknown, ...optionalParams: unknown[]) => {
      loggedMessages.push(String(message));
      for (const optionalParam of optionalParams) {
        loggedMessages.push(String(optionalParam));
      }
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [failingRule],
    });

    expect(result.failedRuleIds).toEqual(["stateless/default-log"]);
    expect(result.summary.failedRules).toBe(1);
    expect(loggedMessages.join(" ")).toContain(
      "[rule-engine] rule failed: stateless/default-log:",
    );
    expect(loggedMessages.join(" ")).toContain("default logger failure");
  });

  test("derives safe-patch policy when patch preview is present", async () => {
    const safePatchPreview: PatchPreview = {
      removedLines: ["const output = oldCall();"],
      addedLines: ["const output = safeCall();"],
      hunkHeader: "@@ -10,1 +10,1 @@",
    };

    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/safe-patch-derived",
        name: "safe patch derived",
        category: "clean",
        languages: ["typescript"],
        description: "safe patch derived",
      },
      analyse: async () => [
        buildFinding("stateless/safe-patch-derived", "clean", {
          patchPreview: safePatchPreview,
        }),
      ],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patchSuggestionPolicy).toBe("safe-patch");
    expect(result.summary.failedRules).toBe(0);
  });

  test("fails a rule when finding declares manual-only with patch preview", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/manual-with-patch",
        name: "manual with patch",
        category: "clean",
        languages: ["typescript"],
        description: "manual with patch",
      },
      analyse: async () => [
        buildFinding("stateless/manual-with-patch", "clean", {
          patchSuggestionPolicy: "manual-only",
          patchPreview: {
            removedLines: ["const value = old();"],
            addedLines: ["const value = next();"],
            hunkHeader: "@@ -1,1 +1,1 @@",
          },
        }),
      ],
    };

    const capturedErrors: string[] = [];
    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
      onRuleExecutionError: (failedRule, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        capturedErrors.push(`${failedRule.metadata.ruleId}:${detail}`);
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.failedRules).toBe(1);
    expect(result.failedRuleIds).toEqual(["stateless/manual-with-patch"]);
    expect(capturedErrors[0]).toContain("manual-only");
  });

  test("fails a rule when finding declares safe-patch without patch preview", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/safe-without-patch",
        name: "safe without patch",
        category: "clean",
        languages: ["typescript"],
        description: "safe without patch",
      },
      analyse: async () => [
        buildFinding("stateless/safe-without-patch", "clean", {
          patchSuggestionPolicy: "safe-patch",
        }),
      ],
    };

    const capturedErrors: string[] = [];
    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
      onRuleExecutionError: (failedRule, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        capturedErrors.push(`${failedRule.metadata.ruleId}:${detail}`);
      },
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.failedRules).toBe(1);
    expect(result.failedRuleIds).toEqual(["stateless/safe-without-patch"]);
    expect(capturedErrors[0]).toContain("safe-patch");
  });

  test("does not keep partial findings when policy enforcement fails mid-rule", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/partial-enforcement-failure",
        name: "partial enforcement failure",
        category: "clean",
        languages: ["typescript"],
        description: "partial enforcement failure",
      },
      analyse: async () => [
        buildFinding("stateless/partial-enforcement-failure", "clean"),
        buildFinding("stateless/partial-enforcement-failure", "clean", {
          patchSuggestionPolicy: "safe-patch",
        }),
      ],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
    });

    expect(result.findings).toEqual([]);
    expect(result.summary.totalFindings).toBe(0);
    expect(result.summary.failedRules).toBe(1);
    expect(result.failedRuleIds).toEqual(["stateless/partial-enforcement-failure"]);
  });

  test("normalizes evidence and recommendation text for reviewer output", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/text-normalization",
        name: "text normalization",
        category: "clean",
        languages: ["typescript"],
        description: "text normalization",
      },
      analyse: async () => [
        buildFinding("stateless/text-normalization", "clean", {
          evidence: " \r\n\r\nconst value: any = input;\r\n\r\n\r\n",
          recommendation: "   \n\nReplace any with a concrete type.\n\n\n",
        }),
      ],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
    });

    expect(result.summary.failedRules).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.evidence).toBe("const value: any = input;");
    expect(result.findings[0]?.recommendation).toBe(
      "Replace any with a concrete type.",
    );
  });

  test("supplies fallback text when evidence or recommendation are blank", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/text-fallbacks",
        name: "text fallbacks",
        category: "clean",
        languages: ["typescript"],
        description: "text fallbacks",
      },
      analyse: async () => [
        buildFinding("stateless/text-fallbacks", "clean", {
          evidence: " \n\t\r\n ",
          recommendation: " \n ",
        }),
      ],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
    });

    expect(result.summary.failedRules).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.evidence).toBe("No evidence provided by rule.");
    expect(result.findings[0]?.recommendation).toBe(
      "No recommendation provided by rule.",
    );
  });

  test("normalizes patch preview lines and hunk header for stable markdown rendering", async () => {
    const rule: StatelessRule = {
      kind: "stateless",
      metadata: {
        ruleId: "stateless/patch-normalization",
        name: "patch normalization",
        category: "clean",
        languages: ["typescript"],
        description: "patch normalization",
      },
      analyse: async () => [
        buildFinding("stateless/patch-normalization", "clean", {
          patchSuggestionPolicy: "safe-patch",
          patchPreview: {
            hunkHeader: "  @@ -10,1 +10,1 @@  \n@@ extra",
            removedLines: ["const output = oldCall();  \r\nignored"],
            addedLines: ["const output = safeCall();  "],
          },
        }),
      ],
    };

    const result = await executeRules({
      context: ANALYSIS_CONTEXT,
      rules: [rule],
    });

    expect(result.summary.failedRules).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patchPreview?.hunkHeader).toBe("@@ -10,1 +10,1 @@");
    expect(result.findings[0]?.patchPreview?.removedLines).toEqual([
      "const output = oldCall();",
    ]);
    expect(result.findings[0]?.patchPreview?.addedLines).toEqual([
      "const output = safeCall();",
    ]);
  });
});
