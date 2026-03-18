import { describe, expect, test } from "bun:test";
import {
  toConfidence,
  toFilePath,
  toLineNumber,
  toRuleId,
} from "@mergewise/shared-types";
import { createLlmReviewerRule } from "./index";
import {
  buildCompletionResponse,
  makeDiff,
  makeHunk,
  makeMockCodebaseContext,
  PULL_REQUEST_METADATA,
  withMockFetch,
} from "./test-helpers";

describe("createLlmReviewerRule", () => {
  test("returns a codebase-aware rule with correct metadata", () => {
    const rule = createLlmReviewerRule({
      clientConfig: { apiKey: "test-key" },
    });

    expect(rule.kind).toBe("codebase-aware");
    expect(rule.metadata.ruleId).toBe(toRuleId("llm/reviewer"));
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
      pullRequest: PULL_REQUEST_METADATA,
    };

    const codebaseContext = makeMockCodebaseContext();
    const findings = await rule.analyse(context, codebaseContext);
    expect(findings).toHaveLength(0);
  });

  test("analyses selected files and returns findings via fake server", async () => {
    await withMockFetch(
      () =>
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
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
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
          pullRequest: PULL_REQUEST_METADATA,
        };
        const codebaseContext = makeMockCodebaseContext({
          "src/service.ts": "const result = processData()\nexport default result",
        });
        const findings = await rule.analyse(context, codebaseContext);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.ruleId).toBe(toRuleId("llm/reviewer"));
        expect(findings[0]!.filePath).toBe(toFilePath("src/service.ts"));
        expect(findings[0]!.line).toBe(toLineNumber(1));
        expect(findings[0]!.category).toBe("clean");
        expect(findings[0]!.confidence).toBe(toConfidence(0.88));
      },
    );
  });

  test("reviews multiple files and flattens findings", async () => {
    await withMockFetch(
      async (request) => {
        const body = await request.json() as { messages?: { content?: string }[] };
        const userMessage = body.messages?.find((message) => message.content?.includes("## File:"))?.content ?? "";
        const isFileA = userMessage.includes("## File: src/a.ts");
        const findingsForFile = isFileA
          ? [{ line: 1, category: "idiomatic", confidence: 0.8, evidence: "const aa", recommendation: "fix a" }]
          : [{ line: 1, category: "safety", confidence: 0.9, evidence: "const bb", recommendation: "fix b" }];
        return new Response(buildCompletionResponse(JSON.stringify({ findings: findingsForFile })), {
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },
        });
        const context = {
          diffs: [
            makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const aa = 1"])]),
            makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const bb = 2"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings).toHaveLength(2);
        const filePaths = findings.map((finding) => finding.filePath);
        expect(filePaths).toContain(toFilePath("src/a.ts"));
        expect(filePaths).toContain(toFilePath("src/b.ts"));
      },
    );
  });

  test("continues silently when a file review fails without onFileReviewError", async () => {
    await withMockFetch(
      () => new Response("Internal Server Error", { status: 500 }),
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
            maxRetries: 0,
          },
        });
        const context = {
          diffs: [
            makeDiff("src/fail.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings).toHaveLength(0);
      },
    );
  });

  test("calls onFileReviewError and continues when a file review fails", async () => {
    let invocationCount = 0;
    await withMockFetch(
      () => {
        invocationCount += 1;
        if (invocationCount === 1) {
          return new Response(
            buildCompletionResponse(
              JSON.stringify({ files: [
                { file: "src/fail.ts", priority: "high", classifications: ["logic"], reasoning: "test" },
                { file: "src/pass.ts", priority: "high", classifications: ["logic"], reasoning: "test" },
              ] }),
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (invocationCount === 2) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                { line: 1, category: "clean", confidence: 0.9, evidence: "const y", recommendation: "keep" },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        const errors: { filePath: string; error: unknown }[] = [];
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
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
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings.some((finding) => finding.filePath === toFilePath("src/pass.ts"))).toBe(true);
        expect(errors.some((error) => error.filePath === toFilePath("src/fail.ts"))).toBe(true);
      },
    );
  });

  test("pipeline mode reports aggregated token usage to onFileReviewComplete", async () => {
    function buildResponseWithUsage(content: string, promptTokens: number, completionTokens: number): string {
      return JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1700000000,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
    }

    let callIndex = 0;
    await withMockFetch(
      () => {
        callIndex++;
        if (callIndex === 1) {
          return new Response(
            buildResponseWithUsage(
              JSON.stringify({ files: [{ file: "src/app.ts", priority: "high", classifications: ["logic"], reasoning: "test" }] }),
              200, 80,
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (callIndex === 2) {
          return new Response(
            buildResponseWithUsage(JSON.stringify({ findings: [] }), 500, 120),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          buildResponseWithUsage(JSON.stringify({ verdicts: [] }), 300, 60),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        const completions: { filePath: string; promptTokens: number; completionTokens: number }[] = [];
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },

          triageModel: "test-triage",
          criticModel: "test-critic",
          onFileReviewComplete: (filePath, _count, promptTokens, completionTokens) => {
            completions.push({ filePath, promptTokens, completionTokens });
          },
        });
        const context = {
          diffs: [makeDiff("src/app.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])])],
          pullRequest: PULL_REQUEST_METADATA,
        };
        await rule.analyse(context, makeMockCodebaseContext());

        expect(completions).toHaveLength(1);
        expect(completions[0]!.filePath).toBe("src/app.ts");
        const totalPromptTokens = completions.reduce((sum, completion) => sum + completion.promptTokens, 0);
        const totalCompletionTokens = completions.reduce((sum, completion) => sum + completion.completionTokens, 0);
        expect(totalPromptTokens).toBe(1000);
        expect(totalCompletionTokens).toBe(260);
      },
    );
  });

  test("pipeline mode reports token usage on first file only when multiple files succeed", async () => {
    let callIndex = 0;
    await withMockFetch(
      () => {
        callIndex++;
        if (callIndex === 1) {
          return new Response(
            buildCompletionResponse(
              JSON.stringify({
                files: [
                  { file: "src/a.ts", priority: "high", classifications: [], reasoning: "test" },
                  { file: "src/b.ts", priority: "high", classifications: [], reasoning: "test" },
                ],
              }),
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          buildCompletionResponse(JSON.stringify({ findings: [], verdicts: [] })),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        const completions: { filePath: string; promptTokens: number; completionTokens: number }[] = [];
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },

          onFileReviewComplete: (filePath, _count, promptTokens, completionTokens) => {
            completions.push({ filePath, promptTokens, completionTokens });
          },
        });
        const context = {
          diffs: [
            makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const a = 1"])]),
            makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const b = 2"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        await rule.analyse(context, makeMockCodebaseContext());

        expect(completions).toHaveLength(2);
        const aCompletion = completions.find((completion) => completion.filePath === "src/a.ts");
        const bCompletion = completions.find((completion) => completion.filePath === "src/b.ts");
        expect(aCompletion!.promptTokens).toBeGreaterThan(0);
        expect(aCompletion!.completionTokens).toBeGreaterThan(0);
        expect(bCompletion!.promptTokens).toBe(0);
        expect(bCompletion!.completionTokens).toBe(0);
      },
    );
  });

  test("pipeline mode reports token usage on second file when first file fails", async () => {
    let triageDone = false;
    await withMockFetch(
      async (request) => {
        const body = await request.text();
        if (!triageDone) {
          triageDone = true;
          return new Response(
            buildCompletionResponse(
              JSON.stringify({
                files: [
                  { file: "src/a.ts", priority: "high", classifications: [], reasoning: "test" },
                  { file: "src/b.ts", priority: "high", classifications: [], reasoning: "test" },
                ],
              }),
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.includes("src/a.ts")) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          buildCompletionResponse(JSON.stringify({ findings: [], verdicts: [] })),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        const completions: { filePath: string; promptTokens: number; completionTokens: number }[] = [];
        const errors: { filePath: string }[] = [];
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },

          onFileReviewComplete: (filePath, _count, promptTokens, completionTokens) => {
            completions.push({ filePath, promptTokens, completionTokens });
          },
          onFileReviewError: (filePath) => {
            errors.push({ filePath });
          },
        });
        const context = {
          diffs: [
            makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const a = 1"])]),
            makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const b = 2"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        await rule.analyse(context, makeMockCodebaseContext());

        expect(errors.some((error) => error.filePath === "src/a.ts")).toBe(true);
        expect(completions.some((completion) => completion.filePath === "src/b.ts" && completion.promptTokens > 0)).toBe(true);
        expect(completions.every((completion) => completion.filePath !== "src/a.ts")).toBe(true);
      },
    );
  });
});
