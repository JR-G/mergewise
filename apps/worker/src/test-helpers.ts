import type { GitHubReactionCounts } from "@mergewise/github-client";
import type { RuleExecutionResult } from "@mergewise/rule-engine";
import type { Finding, FindingCategory, Rule } from "@mergewise/shared-types";

import type { WorkerGitHubFetchOptions } from "./index";

/** Minimal open PR state for dependency injection in worker tests. */
export const openPullRequestState = {
  number: 50,
  state: "open" as const,
  merged: false,
  title: "Test PR",
};

/** Fast-timeout GitHub fetch options suitable for unit tests. */
export const workerFetchOptions: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "mergewise-worker-test",
  githubRequestTimeoutMs: 1000,
  githubFetchRetries: 2,
  githubRetryDelayMs: 1,
};

/** Creates a no-op stateless rule with the given ID, suitable for pipeline wiring tests. */
export function createRule(ruleId: string): Rule {
  return {
    kind: "stateless",
    metadata: {
      ruleId,
      name: ruleId,
      category: "clean",
      languages: ["typescript"],
      description: `${ruleId} description`,
    },
    analyse: () => Promise.resolve([]),
  };
}

/** Creates a posted finding with sensible defaults; override fields via spread after calling. */
export function createFinding(
  findingId: string,
  confidence: number,
  category: FindingCategory,
): Finding {
  return {
    findingId,
    installationId: 44,
    repo: "acme/widget",
    prNumber: 50,
    language: "typescript",
    ruleId: "rule-a",
    category,
    filePath: "src/index.ts",
    line: 1,
    evidence: "const unsafe: any = value",
    recommendation: "Avoid explicit any",
    confidence,
    status: "posted",
  };
}

/** Wraps findings into a full execution result with auto-computed category counts. */
export function createExecutionResultWithFindings(findings: readonly Finding[]): RuleExecutionResult {
  const findingsByCategory = {
    clean: 0,
    perf: 0,
    safety: 0,
    idiomatic: 0,
  };

  for (const finding of findings) {
    findingsByCategory[finding.category] += 1;
  }

  return {
    findings,
    summary: {
      totalRules: 0,
      successfulRules: 0,
      failedRules: 0,
      totalFindings: findings.length,
      findingsByCategory,
    },
    failedRuleIds: [],
  };
}

/** All-zero reaction counts, used as a base for spreading individual reaction overrides. */
export const ZERO_REACTIONS: GitHubReactionCounts = {
  "+1": 0, "-1": 0, laugh: 0, confused: 0, heart: 0, hooray: 0, rocket: 0, eyes: 0,
};
