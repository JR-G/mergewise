import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  CodebaseContext,
  FileDiff,
  DiffHunk,
  PullRequestMetadata,
} from "@mergewise/shared-types";
type TestServer = ReturnType<typeof Bun.serve>;
import {
  selectFilesForReview,
  extractAddedLineNumbers,
  parseLlmResponse,
  buildSystemPrompt,
  buildFileReviewPrompt,
  extractStructuralSignals,
  createLlmReviewerRule,
  createReviewClient,
} from "./index";
import { reviewFile } from "./review-file";

function makeHunk(header: string, lines: string[]): DiffHunk {
  return { header, lines };
}

function makeDiff(filePath: string, hunks: DiffHunk[]): FileDiff {
  return { filePath, previousPath: null, hunks };
}

const PR_METADATA: PullRequestMetadata = {
  repo: "acme/widget",
  prNumber: 42,
  headSha: "abc123",
  installationId: 1,
};

function makeMockCodebaseContext(files: Record<string, string> = {}): CodebaseContext {
  return {
    symbols: [],
    conventions: new Map(),
    readFile: async (path: string) => files[path] ?? null,
  };
}

describe("selectFilesForReview", () => {
  test("skips test files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+line1", "+line2", "+line3", "+line4", "+line5"])]),
      makeDiff("src/app.spec.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]),
      makeDiff("__tests__/util.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+x", "+y"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips config and lockfiles", () => {
    const diffs: FileDiff[] = [
      makeDiff("eslint.config.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("tsconfig.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("package-lock.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("bun.lockb", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips non-TypeScript files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/styles.css", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("README.md", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/data.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("selects TypeScript files sorted by added line count", () => {
    const small = makeDiff("src/small.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]);
    const large = makeDiff("src/large.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+a", "+b", "+c", "+d", "+e"])]);

    const result = selectFilesForReview([small, large], 100_000);
    expect(result).toHaveLength(2);
    expect(result[0]!.filePath).toBe("src/large.ts");
    expect(result[1]!.filePath).toBe("src/small.ts");
  });

  test("prefers tsx over ts at equal change volume", () => {
    const tsFile = makeDiff("src/util.ts", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);
    const tsxFile = makeDiff("src/Component.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);

    const result = selectFilesForReview([tsFile, tsxFile], 100_000);
    expect(result[0]!.filePath).toBe("src/Component.tsx");
  });

  test("respects token budget", () => {
    const file1 = makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_, idx) => `+line${idx}`))]);
    const file2 = makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_, idx) => `+line${idx}`))]);

    const result = selectFilesForReview([file1, file2], 44);
    expect(result).toHaveLength(1);
  });

  test("always includes at least one file even if it exceeds budget", () => {
    const bigFile = makeDiff("src/big.ts", [makeHunk("@@ -0,0 +1,100 @@", Array.from({ length: 100 }, (_, idx) => `+line${idx}`))]);

    const result = selectFilesForReview([bigFile], 10);
    expect(result).toHaveLength(1);
  });
});

describe("extractAddedLineNumbers", () => {
  test("extracts added line numbers from hunks", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,3 +1,5 @@", [
        " existing",
        "+added1",
        "+added2",
        " existing2",
        "+added3",
      ]),
    ]);

    const result = extractAddedLineNumbers(diff);
    expect(result).toEqual(new Set([2, 3, 5]));
  });

  test("skips deleted lines in line counting", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,4 +1,3 @@", [
        " keep",
        "-removed",
        "+added",
        " keep2",
      ]),
    ]);

    const result = extractAddedLineNumbers(diff);
    expect(result).toEqual(new Set([2]));
  });
});

describe("parseLlmResponse", () => {
  const diff = makeDiff("src/file.ts", [
    makeHunk("@@ -1,3 +1,5 @@", [
      " existing",
      "+added line 2",
      "+added line 3",
      " existing2",
      "+added line 5",
    ]),
  ]);

  test("parses valid JSON response", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "idiomatic",
          confidence: 0.85,
          evidence: "const data = fetchData()",
          recommendation: "Rename 'data' to reflect what it contains.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(2);
    expect(result[0]!.category).toBe("idiomatic");
    expect(result[0]!.confidence).toBe(0.85);
    expect(result[0]!.ruleId).toBe("llm/reviewer");
    expect(result[0]!.patchSuggestionPolicy).toBe("manual-only");
    expect(result[0]!.status).toBe("posted");
  });

  test("discards findings on non-added lines", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "existing code",
          recommendation: "Refactor this.",
        },
        {
          line: 99,
          category: "clean",
          confidence: 0.9,
          evidence: "hallucinated line",
          recommendation: "Does not exist.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("discards findings with invalid category", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "style",
          confidence: 0.9,
          evidence: "code",
          recommendation: "Fix it.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("discards findings with out-of-range confidence", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 1.5,
          evidence: "code",
          recommendation: "Fix it.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for malformed JSON", () => {
    const result = parseLlmResponse("not json at all", diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for missing findings key", () => {
    const result = parseLlmResponse('{"comments": []}', diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("generates correct findingId", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 3,
          category: "safety",
          confidence: 0.92,
          evidence: "unsafe cast",
          recommendation: "Remove the type assertion.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result[0]!.findingId).toBe("llm/reviewer:acme/widget:42:src/file.ts:3:safety");
  });
});

describe("buildSystemPrompt", () => {
  test("includes key review focus areas", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SOLID");
    expect(prompt).toContain("DRY");
    expect(prompt).toContain("KISS");
    expect(prompt).toContain("AI slop");
    expect(prompt).toContain("Naming quality");
  });

  test("excludes lint/formatting concerns", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("What NOT to flag");
    expect(prompt).toContain("Formatting");
  });
});

describe("buildFileReviewPrompt", () => {
  test("includes diff content and file path", () => {
    const diff = makeDiff("src/app.tsx", [
      makeHunk("@@ -1,2 +1,3 @@", [" import React", "+const App = () => {", "+}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, {
      componentLineCount: 0,
      hookCount: 0,
      importCount: 0,
      maxNestingDepth: 0,
    });

    expect(prompt).toContain("src/app.tsx");
    expect(prompt).toContain("const App = () => {");
  });

  test("includes full file content when provided", () => {
    const diff = makeDiff("src/util.ts", [
      makeHunk("@@ -1,1 +1,2 @@", [" export function foo() {}", "+export function bar() {}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, "full file content here", {
      componentLineCount: 0,
      hookCount: 0,
      importCount: 0,
      maxNestingDepth: 0,
    });

    expect(prompt).toContain("full file content here");
    expect(prompt).toContain("Full file content");
  });

  test("includes structural signals when non-zero", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -1,1 +1,2 @@", ["+const x = 1"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, {
      componentLineCount: 150,
      hookCount: 8,
      importCount: 12,
      maxNestingDepth: 4,
    });

    expect(prompt).toContain("Component line count: 150");
    expect(prompt).toContain("useState/useEffect calls: 8");
    expect(prompt).toContain("Import statements: 12");
    expect(prompt).toContain("Max callback/promise nesting depth: 4");
  });
});

describe("extractStructuralSignals", () => {
  test("counts hook calls", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+const [x, setX] = useState(0)",
        "+useEffect(() => {}, [])",
        "+const ref = useRef(null)",
        "+const memo = useMemo(() => x, [x])",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.hookCount).toBe(4);
  });

  test("counts import statements", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+import React from 'react'",
        "+import { useState } from 'react'",
        "+const x = 1",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.importCount).toBe(2);
  });

  test("tracks nesting depth", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,5 @@", [
        "+function outer() {",
        "+  if (true) {",
        "+    callback(() => {",
        "+    })",
        "+  }",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxNestingDepth).toBeGreaterThanOrEqual(3);
  });
});

function buildCompletionResponse(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

describe("ReviewClient (via fake HTTP server)", () => {
  let server: TestServer;
  let serverUrl: string;
  let lastRequestBody: Record<string, unknown> | null = null;
  let responseContent = '{"findings": []}';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as Record<string, unknown>;
        lastRequestBody = body;
        return new Response(buildCompletionResponse(responseContent), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    serverUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("sends correct request structure to OpenAI-compatible endpoint", async () => {
    responseContent = JSON.stringify({ findings: [] });

    const client = createReviewClient({
      apiKey: "test-api-key",
      baseUrl: serverUrl,
      model: "test-model",
    });

    await client.complete("system prompt", "user prompt", 1024);

    expect(lastRequestBody).not.toBeNull();
    expect(lastRequestBody!["model"]).toBe("test-model");
    expect(lastRequestBody!["temperature"]).toBe(0.2);
    expect(lastRequestBody!["max_completion_tokens"]).toBe(1024);

    const messages = lastRequestBody!["messages"] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe("system prompt");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toBe("user prompt");
  });

  test("returns parsed content from the LLM response", async () => {
    responseContent = JSON.stringify({ findings: [{ line: 1 }] });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: serverUrl,
      model: "test-model",
    });

    const result = await client.complete("sys", "usr", 512);
    const parsed = JSON.parse(result) as { findings: Array<{ line: number }> };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.line).toBe(1);
  });

  test("throws on empty response content", async () => {
    const emptyServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion",
            created: 1700000000,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: `http://localhost:${emptyServer.port}/v1`,
      model: "test-model",
    });

    await expect(client.complete("sys", "usr", 512)).rejects.toThrow(
      "LLM returned empty response",
    );

    await emptyServer.stop(true);
  });
});

describe("reviewFile (via fake HTTP server)", () => {
  let server: TestServer;
  let serverUrl: string;
  let nextResponse = '{"findings": []}';

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: () => {
        const content = nextResponse;
        return new Response(buildCompletionResponse(content), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    serverUrl = `http://localhost:${server.port}/v1`;
  });

  afterAll(async () => {
    await server.stop(true);
  });

  test("returns validated findings through the full pipeline", async () => {
    const diff = makeDiff("src/app.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+const data = fetch()",
        "+const info = parse(data)",
        "+export default info",
      ]),
    ]);

    nextResponse = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "idiomatic",
          confidence: 0.85,
          evidence: "const data = fetch()",
          recommendation: "Rename 'data' to describe what is being fetched.",
        },
      ],
    });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: serverUrl,
      model: "test-model",
      maxRetries: 0,
    });

    const codebaseContext = makeMockCodebaseContext({
      "src/app.ts": "const data = fetch()\nconst info = parse(data)\nexport default info",
    });

    const findings = await reviewFile(diff, PR_METADATA, codebaseContext, client);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.category).toBe("idiomatic");
    expect(findings[0]!.confidence).toBe(0.85);
    expect(findings[0]!.ruleId).toBe("llm/reviewer");
    expect(findings[0]!.filePath).toBe("src/app.ts");
    expect(findings[0]!.patchSuggestionPolicy).toBe("manual-only");
    expect(findings[0]!.status).toBe("posted");
  });

  test("returns empty array when LLM finds nothing", async () => {
    const diff = makeDiff("src/clean.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+export const VERSION = '1.0.0'"]),
    ]);

    nextResponse = JSON.stringify({ findings: [] });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: serverUrl,
      model: "test-model",
      maxRetries: 0,
    });

    const findings = await reviewFile(diff, PR_METADATA, makeMockCodebaseContext(), client);
    expect(findings).toHaveLength(0);
  });

  test("discards hallucinated line numbers from LLM", async () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+const valid = true"]),
    ]);

    nextResponse = JSON.stringify({
      findings: [
        { line: 999, category: "clean", confidence: 0.9, evidence: "ghost", recommendation: "Does not exist." },
      ],
    });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: serverUrl,
      model: "test-model",
      maxRetries: 0,
    });

    const findings = await reviewFile(diff, PR_METADATA, makeMockCodebaseContext(), client);
    expect(findings).toHaveLength(0);
  });

  test("handles file not found in codebase gracefully", async () => {
    const diff = makeDiff("src/new-file.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+export const NEW = true"]),
    ]);

    nextResponse = JSON.stringify({ findings: [] });

    const client = createReviewClient({
      apiKey: "test-key",
      baseUrl: serverUrl,
      model: "test-model",
      maxRetries: 0,
    });

    const emptyContext = makeMockCodebaseContext();
    const findings = await reviewFile(diff, PR_METADATA, emptyContext, client);
    expect(findings).toHaveLength(0);
  });
});

describe("createLlmReviewerRule", () => {
  test("returns a codebase-aware rule with correct metadata", () => {
    const rule = createLlmReviewerRule({
      clientConfig: { apiKey: "test-key" },
    });

    expect(rule.kind).toBe("codebase-aware");
    expect(rule.metadata.ruleId).toBe("llm/reviewer");
    expect(rule.metadata.category).toBe("idiomatic");
    expect(rule.metadata.languages).toContain("typescript");
  });

  test("returns empty findings when no files match selection criteria", async () => {
    const rule = createLlmReviewerRule({
      clientConfig: { apiKey: "test-key" },
    });

    const context = {
      diffs: [
        makeDiff("README.md", [makeHunk("@@ -0,0 +1,1 @@", ["+# Hello"])]),
        makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+test()"])]),
      ],
      pullRequest: PR_METADATA,
    };

    const codebaseContext = makeMockCodebaseContext();
    const findings = await rule.analyse(context, codebaseContext);
    expect(findings).toHaveLength(0);
  });

  test("analyses selected files and returns findings via fake server", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                {
                  line: 1,
                  category: "clean",
                  confidence: 0.88,
                  evidence: "const result = processData()",
                  recommendation: "Rename 'result' to describe the processed output.",
                },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    });

    const rule = createLlmReviewerRule({
      clientConfig: {
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        model: "test-model",
      },
    });

    const context = {
      diffs: [
        makeDiff("src/service.ts", [
          makeHunk("@@ -0,0 +1,2 @@", [
            "+const result = processData()",
            "+export default result",
          ]),
        ]),
      ],
      pullRequest: PR_METADATA,
    };

    const codebaseContext = makeMockCodebaseContext({
      "src/service.ts": "const result = processData()\nexport default result",
    });

    const findings = await rule.analyse(context, codebaseContext);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe("llm/reviewer");
    expect(findings[0]!.filePath).toBe("src/service.ts");
    expect(findings[0]!.line).toBe(1);
    expect(findings[0]!.category).toBe("clean");
    expect(findings[0]!.confidence).toBe(0.88);

    await server.stop(true);
  });

  test("reviews multiple files and flattens findings", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        callCount += 1;
        const findingsForCall =
          callCount === 1
            ? [{ line: 1, category: "idiomatic", confidence: 0.8, evidence: "a", recommendation: "fix a" }]
            : [{ line: 1, category: "safety", confidence: 0.9, evidence: "b", recommendation: "fix b" }];

        return new Response(
          buildCompletionResponse(JSON.stringify({ findings: findingsForCall })),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const rule = createLlmReviewerRule({
      clientConfig: {
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        model: "test-model",
      },
    });

    const context = {
      diffs: [
        makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const aa = 1"])]),
        makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const bb = 2"])]),
      ],
      pullRequest: PR_METADATA,
    };

    const findings = await rule.analyse(context, makeMockCodebaseContext());

    expect(findings).toHaveLength(2);
    expect(findings[0]!.filePath).toBe("src/a.ts");
    expect(findings[1]!.filePath).toBe("src/b.ts");

    await server.stop(true);
  });

  test("continues silently when a file review fails without onFileReviewError", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("Internal Server Error", { status: 500 }),
    });

    const rule = createLlmReviewerRule({
      clientConfig: {
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        model: "test-model",
        maxRetries: 0,
      },
    });

    const context = {
      diffs: [
        makeDiff("src/fail.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])]),
      ],
      pullRequest: PR_METADATA,
    };

    const findings = await rule.analyse(context, makeMockCodebaseContext());
    expect(findings).toHaveLength(0);

    await server.stop(true);
  });

  test("calls onFileReviewError and continues when a file review fails", async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                { line: 1, category: "clean", confidence: 0.9, evidence: "ok", recommendation: "keep" },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const errors: Array<{ filePath: string; error: unknown }> = [];
    const rule = createLlmReviewerRule({
      clientConfig: {
        apiKey: "test-key",
        baseUrl: `http://localhost:${server.port}/v1`,
        model: "test-model",
        maxRetries: 0,
      },
      onFileReviewError: (filePath, error) => {
        errors.push({ filePath, error });
      },
    });

    const context = {
      diffs: [
        makeDiff("src/fail.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])]),
        makeDiff("src/pass.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const y = 2"])]),
      ],
      pullRequest: PR_METADATA,
    };

    const findings = await rule.analyse(context, makeMockCodebaseContext());

    expect(findings).toHaveLength(1);
    expect(findings[0]!.filePath).toBe("src/pass.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.filePath).toBe("src/fail.ts");

    await server.stop(true);
  });
});
