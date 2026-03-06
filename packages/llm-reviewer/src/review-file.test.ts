import { describe, it, expect, mock } from "bun:test";
import type {
  CodebaseContext,
  FileDiff,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import type { ReviewClient, CompletionResult } from "./client";
import { reviewFile } from "./review-file";

const STUB_PR: PullRequestMetadata = {
  repo: "test/repo",
  prNumber: 1,
  headSha: "abc123",
  installationId: null,
};

const STUB_DIFF: FileDiff = {
  filePath: "src/index.ts",
  previousPath: null,
  hunks: [
    {
      header: "@@ -1,3 +1,5 @@",
      lines: ["+const x = fetchData();", "+const y = 2;", " context"],
    },
  ],
};

function makeCodebaseContext(fileContent: string | null = "const x = 1;"): CodebaseContext {
  return {
    symbols: [],
    conventions: new Map(),
    readFile: mock(() => Promise.resolve(fileContent)),
  };
}

function makeMockClient(responseContent: string): ReviewClient {
  const result: CompletionResult = {
    content: responseContent,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
  return {
    complete: mock(() => Promise.resolve(result)),
  } as unknown as ReviewClient;
}

describe("reviewFile", () => {
  it("returns findings from a valid LLM response", async () => {
    const validResponse = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "fetchData call",
          recommendation: "Extract into a helper function",
        },
      ],
    });
    const client = makeMockClient(validResponse);
    const codebaseContext = makeCodebaseContext();

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(result.findings.some((finding) => finding.line === 1)).toBe(true);
    expect(result.usage).toBeDefined();
  });

  it("returns empty findings when LLM returns no findings", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext();

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(result.findings).toEqual([]);
  });

  it("calls client.complete with expected arguments", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext();

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it("reads full file content from codebase context", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext();

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(codebaseContext.readFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("clamps consistencySamples to at least 1", async () => {
    const validResponse = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "fetchData call",
          recommendation: "Extract into a helper function",
        },
      ],
    });
    const client = makeMockClient(validResponse);
    const codebaseContext = makeCodebaseContext();

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
      consistencySamples: -5,
    });

    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(result.findings.length).toBeGreaterThanOrEqual(0);
  });
});
