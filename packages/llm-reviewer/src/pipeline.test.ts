import { describe, expect, test } from "bun:test";
import type { CodebaseContext, FileDiff, PullRequestMetadata } from "@mergewise/shared-types";
import { toFilePath, toPRNumber, toRepoFullName, toSHA } from "@mergewise/shared-types";
import type { ReviewPipelineConfig } from "./pipeline-types";
import { runReviewPipeline } from "./pipeline";

function makeDiff(filePath: string, addedLines = 3): FileDiff {
  const lines = [" const existing = 1;"];
  for (let index = 0; index < addedLines; index++) {
    lines.push(`+const added${index} = ${index};`);
  }
  return {
    filePath: toFilePath(filePath),
    previousPath: null,
    hunks: [{ header: "@@ -1,1 +1,4 @@", lines }],
  };
}

const PULL_REQUEST: PullRequestMetadata = {
  repo: toRepoFullName("owner/repo"),
  prNumber: toPRNumber(42),
  headSha: toSHA("a".repeat(40)),
  installationId: null,
};

function makeCodebaseContext(fileContents: Record<string, string> = {}): CodebaseContext {
  return {
    symbols: [],
    conventions: new Map(),
    readFile: async (path) => fileContents[path] ?? null,
  };
}

function makeConfig(overrides: Partial<ReviewPipelineConfig> = {}): ReviewPipelineConfig {
  return {
    reviewModel: "test-model",
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:1/v1",
    maxRetries: 0,
    ...overrides,
  };
}

describe("runReviewPipeline", () => {
  test("returns empty results for empty diffs", async () => {
    const result = await runReviewPipeline([], PULL_REQUEST, makeCodebaseContext(), makeConfig());

    expect(result.findings).toEqual([]);
    expect(result.triageResults).toEqual([]);
    expect(result.criticReport.findings).toEqual([]);
    expect(result.criticReport.filtered).toEqual([]);
    expect(result.failedFiles).toEqual([]);
  });

  test("degrades gracefully when triage API is unreachable", async () => {
    const diffs = [makeDiff("src/index.ts", 3)];
    const config = makeConfig();

    const result = await runReviewPipeline(diffs, PULL_REQUEST, makeCodebaseContext(), config);

    expect(result.triageResults.length).toBe(1);
    expect(result.triageResults[0]!.priority).toBe("high");
    expect(result.triageResults[0]!.reasoning).toContain("Triage unavailable");
    expect(result.failedFiles.some((failure) => failure.filePath === toFilePath("src/index.ts"))).toBe(true);
  });

  test("returns valid token usage summary even when all stages fail", async () => {
    const diffs = [makeDiff("src/index.ts", 3)];
    const config = makeConfig();

    const result = await runReviewPipeline(diffs, PULL_REQUEST, makeCodebaseContext(), config);

    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage.triageUsage).toBeUndefined();
    expect(result.tokenUsage.reviewUsage).toBeUndefined();
    expect(result.tokenUsage.criticUsage).toBeUndefined();
    expect(result.tokenUsage.totalUsage).toBeUndefined();
  });

  test("produces valid structure with multiple diffs", async () => {
    const diffs = [
      makeDiff("src/index.ts", 3),
      makeDiff("src/utils.ts", 2),
      makeDiff("src/config.ts", 1),
    ];
    const config = makeConfig({ maxFilesPerReview: 2 });

    const result = await runReviewPipeline(diffs, PULL_REQUEST, makeCodebaseContext(), config);

    expect(result.triageResults.length).toBe(3);
    expect(result.criticReport).toBeDefined();
    expect(result.findings).toBeDefined();
  });

  test("critic report defaults to empty when no findings", async () => {
    const diffs = [makeDiff("src/index.ts", 3)];
    const config = makeConfig();

    const result = await runReviewPipeline(diffs, PULL_REQUEST, makeCodebaseContext(), config);

    expect(result.criticReport.findings).toEqual([]);
    expect(result.criticReport.filtered).toEqual([]);
  });
});
