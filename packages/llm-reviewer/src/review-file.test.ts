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

function makeMockClient(responseContent: string): ReviewClient & { completeCalls: string[][] } {
  const result: CompletionResult = {
    content: responseContent,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  };
  const completeCalls: string[][] = [];
  return {
    completeCalls,
    complete: mock((...args: string[]) => { completeCalls.push(args); return Promise.resolve(result); }),
  } as unknown as ReviewClient & { completeCalls: string[][] };
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

  it("produces a result even when file content is null", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext(null);

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(result.findings).toEqual([]);
  });

  it("includes full file content in the LLM prompt", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext("FULL_FILE_CONTENT");

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    const userPrompt = client.completeCalls[0]?.[1] ?? "";
    expect(userPrompt).toContain("FULL_FILE_CONTENT");
  });

  it("clamps negative consistencySamples to 1 (single-shot path)", async () => {
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

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
      consistencySamples: -5,
    });

    expect(client.completeCalls).toHaveLength(1);
  });

  it("clamps zero consistencySamples to 1 (single-shot path)", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext();

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
      consistencySamples: 0,
    });

    expect(client.completeCalls).toHaveLength(1);
  });

  it("clamps NaN consistencySamples to 1 (single-shot path)", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext = makeCodebaseContext();

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
      consistencySamples: NaN,
    });

    expect(client.completeCalls).toHaveLength(1);
  });

  it("uses multiple samples when consistencySamples is 3", async () => {
    const validResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(validResponse);
    const codebaseContext = makeCodebaseContext();

    await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
      consistencySamples: 3,
    });

    expect(client.completeCalls).toHaveLength(3);
  });

  it("returns empty findings for malformed JSON from LLM", async () => {
    const client = makeMockClient("not valid json {{{");
    const codebaseContext = makeCodebaseContext();

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(result.findings).toEqual([]);
  });

  it("returns empty findings for schema-invalid JSON from LLM", async () => {
    const client = makeMockClient(JSON.stringify({ not_findings: true }));
    const codebaseContext = makeCodebaseContext();

    const result = await reviewFile({
      fileDiff: STUB_DIFF,
      pullRequest: STUB_PR,
      codebaseContext,
      client,
    });

    expect(result.findings).toEqual([]);
  });

  it("propagates rejection when client.complete throws", async () => {
    const failingClient = {
      complete: mock(() => Promise.reject(new Error("LLM service unavailable"))),
    } as unknown as ReviewClient;
    const codebaseContext = makeCodebaseContext();

    let thrownError: unknown;
    try {
      await reviewFile({
        fileDiff: STUB_DIFF,
        pullRequest: STUB_PR,
        codebaseContext,
        client: failingClient,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("LLM service unavailable");
  });

  it("propagates error when readFile throws", async () => {
    const emptyResponse = JSON.stringify({ findings: [] });
    const client = makeMockClient(emptyResponse);
    const codebaseContext: CodebaseContext = {
      symbols: [],
      conventions: new Map(),
      readFile: mock(() => Promise.reject(new Error("file read failed"))),
    };

    let thrownError: unknown;
    try {
      await reviewFile({
        fileDiff: STUB_DIFF,
        pullRequest: STUB_PR,
        codebaseContext,
        client,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("file read failed");
  });
});
