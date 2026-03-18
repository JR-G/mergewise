import { describe, expect, test } from "bun:test";

import {
  generateJobId,
  toConfidence,
  toFilePath,
  toInstallationId,
  toLineNumber,
  toPRNumber,
  toRepoFullName,
  toRuleId,
  toSHA,
} from "@mergewise/shared-types";

import {
  buildAnalysisContext,
  buildFindingDedupeKey,
  buildIdempotencyKey,
  buildJobSummary,
  parseRepositoryFullName,
  resolveJobTraceId,
  wrapCodeIdentifiers,
} from "./index";

const SHA_ABC = toSHA("abc123".padEnd(40, "0"));
const SHA_AAA = toSHA("a".repeat(40));
const SHA_BBB = toSHA("b".repeat(40));

describe("buildIdempotencyKey", () => {
  test("produces repo#pr@sha format", () => {
    const key = buildIdempotencyKey({
      job_id: generateJobId(),
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      queued_at: "2025-01-01T00:00:00Z",
    });
    expect(key).toBe(`acme/widget#42@${SHA_ABC}`);
  });

  test("different SHA produces different key", () => {
    const base = {
      job_id: generateJobId(),
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      queued_at: "2025-01-01T00:00:00Z",
    };

    const keyA = buildIdempotencyKey({ ...base, head_sha: SHA_AAA });
    const keyB = buildIdempotencyKey({ ...base, head_sha: SHA_BBB });
    expect(keyA).not.toBe(keyB);
  });
});

describe("resolveJobTraceId", () => {
  test("uses explicit job trace_id when provided", () => {
    const jobId = generateJobId();
    const traceId = resolveJobTraceId({
      job_id: jobId,
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      trace_id: "trace-123",
      queued_at: "2025-01-01T00:00:00Z",
    });

    expect(traceId).toBe("trace-123");
  });

  test("falls back to job_id when trace_id is missing", () => {
    const jobId = generateJobId();
    const traceId = resolveJobTraceId({
      job_id: jobId,
      installation_id: toInstallationId(1),
      repo_full_name: toRepoFullName("acme/widget"),
      pr_number: toPRNumber(42),
      head_sha: SHA_ABC,
      queued_at: "2025-01-01T00:00:00Z",
    });

    expect(traceId).toBe(jobId);
  });
});

describe("buildFindingDedupeKey", () => {
  test("builds stable key from findingId", () => {
    const finding = {
      findingId: "r1:file:1",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(1),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:r1:file:1");
  });

  test("builds fallback key from ruleId:filePath:line when findingId is empty", () => {
    const finding = {
      findingId: "",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(10),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:test/rule-1:src/index.ts:10");
  });

  test("builds fallback key when findingId is whitespace-only", () => {
    const finding = {
      findingId: "   ",
      installationId: toInstallationId(1),
      repo: toRepoFullName("acme/widget"),
      prNumber: toPRNumber(42),
      language: "typescript",
      ruleId: toRuleId("test/rule-1"),
      category: "safety" as const,
      filePath: toFilePath("src/index.ts"),
      line: toLineNumber(10),
      evidence: "const value: any = input;",
      recommendation: "Use an explicit type.",
      confidence: toConfidence(0.95),
      status: "posted" as const,
    };

    expect(buildFindingDedupeKey(finding)).toBe("acme/widget#42:test/rule-1:src/index.ts:10");
  });
});

describe("parseRepositoryFullName", () => {
  test("returns owner and repository for valid value", () => {
    expect(parseRepositoryFullName("acme/widget")).toEqual({
      owner: "acme",
      repository: "widget",
    });
  });

  test("returns null for invalid values", () => {
    expect(parseRepositoryFullName("acme")).toBeNull();
    expect(parseRepositoryFullName("acme/widget/extra")).toBeNull();
    expect(parseRepositoryFullName("/")).toBeNull();
  });
});

describe("buildAnalysisContext", () => {
  test("maps queued job fields and provided diffs to analysis context", () => {
    const context = buildAnalysisContext(
      {
        job_id: generateJobId(),
        installation_id: toInstallationId(99),
        repo_full_name: toRepoFullName("acme/widget"),
        pr_number: toPRNumber(42),
        head_sha: SHA_ABC,
        queued_at: "2025-01-01T00:00:00Z",
      },
      [
        {
          filePath: toFilePath("src/index.ts"),
          previousPath: null,
          hunks: [
            {
              header: "@@ -1,1 +1,2 @@",
              lines: ["-const a = 1;", "+const value = 1;", "+const b = 2;"],
            },
          ],
        },
      ],
    );

    expect(context.diffs).toHaveLength(1);
    expect(context.diffs[0]?.filePath).toBe(toFilePath("src/index.ts"));
    expect(context.pullRequest.repo).toBe(toRepoFullName("acme/widget"));
    expect(context.pullRequest.prNumber).toBe(toPRNumber(42));
    expect(context.pullRequest.headSha).toBe(SHA_ABC);
    expect(context.pullRequest.installationId).toBe(toInstallationId(99));
  });
});

describe("buildJobSummary", () => {
  test("returns deterministic summary fields from execution result", () => {
    const jobId = generateJobId();
    const summary = buildJobSummary(
      {
        job_id: jobId,
        installation_id: toInstallationId(99),
        repo_full_name: toRepoFullName("acme/widget"),
        pr_number: toPRNumber(42),
        head_sha: SHA_ABC,
        queued_at: "2025-01-01T00:00:00Z",
      },
      `acme/widget#42@${SHA_ABC}`,
      {
        findings: [],
        summary: {
          totalRules: 1,
          successfulRules: 1,
          failedRules: 0,
          totalFindings: 0,
          findingsByCategory: {
            clean: 0,
            perf: 0,
            safety: 0,
            idiomatic: 0,
          },
        },
        failedRuleIds: [],
      },
      "2026-01-02T03:04:05.000Z",
    );

    expect(summary.jobId).toBe(jobId);
    expect(summary.idempotencyKey).toBe(`acme/widget#42@${SHA_ABC}`);
    expect(summary.repository).toBe("acme/widget");
    expect(summary.pullRequestNumber).toBe(42);
    expect(summary.traceId).toBe(jobId);
    expect(summary.totalFindings).toBe(0);
    expect(summary.totalRules).toBe(1);
    expect(summary.successfulRules).toBe(1);
    expect(summary.failedRules).toBe(0);
    expect(summary.failedRuleIds).toEqual([]);
    expect(summary.processedAt).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("wrapCodeIdentifiers", () => {
  test("wraps camelCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Refactor processUserRequest to adhere to SRP")).toBe(
      "Refactor `processUserRequest` to adhere to SRP",
    );
  });

  test("wraps PascalCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Extract UserService into a separate module")).toBe(
      "Extract `UserService` into a separate module",
    );
  });

  test("wraps dotted member access in backticks", () => {
    expect(wrapCodeIdentifiers("Call this.handleRequest instead")).toBe(
      "Call `this.handleRequest` instead",
    );
  });

  test("preserves identifiers already in backticks", () => {
    expect(wrapCodeIdentifiers("Use `processUserRequest` here")).toBe(
      "Use `processUserRequest` here",
    );
  });

  test("leaves plain words unchanged", () => {
    expect(wrapCodeIdentifiers("Extract the logic into separate functions")).toBe(
      "Extract the logic into separate functions",
    );
  });

  test("leaves acronyms and uppercase words unchanged", () => {
    expect(wrapCodeIdentifiers("Follow SRP and DRY principles")).toBe(
      "Follow SRP and DRY principles",
    );
  });

  test("wraps single-quoted camelCase identifiers in backticks", () => {
    expect(wrapCodeIdentifiers("Use the 'suggestedRewrite' field")).toBe(
      "Use the `suggestedRewrite` field",
    );
  });

  test("leaves single-quoted plain words unchanged", () => {
    expect(wrapCodeIdentifiers("This is a 'simple' example")).toBe(
      "This is a 'simple' example",
    );
  });
});

