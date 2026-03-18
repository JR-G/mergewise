import type {
  AnalysisContext,
  Finding,
  FileDiff,
  Rule,
} from "@mergewise/shared-types";
import {
  toConfidence,
  toFilePath,
  toLineNumber,
  toRuleId,
} from "@mergewise/shared-types";

/**
 * Creates a stateless rule that produces one finding per file in the diff.
 * The finding's evidence includes the file path, making it easy to assert
 * that all files were visited by the rule engine.
 *
 * @param ruleId - Unique identifier for this rule instance.
 * @returns A stateless rule suitable for integration testing.
 */
export function createEchoRule(ruleId = "test/echo"): Rule {
  return {
    kind: "stateless",
    metadata: {
      ruleId: toRuleId(ruleId),
      name: `echo-${ruleId}`,
      category: "clean",
      languages: ["typescript"],
      description: "Integration test rule that echoes one finding per file",
    },
    analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
      return Promise.resolve(context.diffs.map((diff: FileDiff, index: number): Finding => ({
        findingId: `${ruleId}-${diff.filePath}-${index}`,
        installationId: context.pullRequest.installationId,
        repo: context.pullRequest.repo,
        prNumber: context.pullRequest.prNumber,
        language: "typescript",
        ruleId: toRuleId(ruleId),
        category: "clean",
        filePath: toFilePath(diff.filePath),
        line: toLineNumber(1),
        evidence: `File reviewed: ${diff.filePath}`,
        recommendation: `Refactoring suggestion for ${diff.filePath}`,
        confidence: toConfidence(0.9),
        status: "posted",
      })));
    },
  };
}

/**
 * Creates a stateless rule that returns a fixed set of findings regardless
 * of the input context. Useful for testing dedup, cap, and delivery logic
 * with predictable data.
 *
 * @param findings - The exact findings to return.
 * @returns A stateless rule returning the provided findings.
 */
export function createFixedFindingsRule(findings: readonly Finding[]): Rule {
  return {
    kind: "stateless",
    metadata: {
      ruleId: toRuleId("test/fixed-findings"),
      name: "fixed-findings",
      category: "clean",
      languages: ["typescript"],
      description: "Integration test rule returning fixed findings",
    },
    analyse: (): Promise<readonly Finding[]> => Promise.resolve(findings),
  };
}
