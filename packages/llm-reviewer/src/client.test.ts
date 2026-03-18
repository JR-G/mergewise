import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { ReviewClient, createReviewClient, mergeUsage } from "./client";
import type { CompletionUsage, ReviewClientConfig, CompleteWithToolsOptions } from "./client";

describe("ReviewClient", () => {
  it("defaults to gpt-4.1 when no model is specified", () => {
    const config: ReviewClientConfig = { apiKey: "test-key" };
    const client = createReviewClient(config);
    expect(client).toBeInstanceOf(ReviewClient);
  });

  it("accepts a custom model via config", () => {
    const config: ReviewClientConfig = {
      apiKey: "test-key",
      model: "gpt-4o-mini",
    };
    const client = new ReviewClient(config);
    expect(client).toBeInstanceOf(ReviewClient);
  });

  it("accepts a custom base URL for alternative providers", () => {
    const config: ReviewClientConfig = {
      apiKey: "test-key",
      baseUrl: "https://api.together.xyz/v1",
      model: "meta-llama/Meta-Llama-3-70B",
    };
    const client = createReviewClient(config);
    expect(client).toBeInstanceOf(ReviewClient);
  });

  describe("outbound request behaviour", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("sends completion request to configured baseUrl with configured model", async () => {
      const capturedUrls: string[] = [];
      const capturedBodies: unknown[] = [];

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const bodyText = typeof init?.body === "string" ? init.body : "{}";
        capturedBodies.push(JSON.parse(bodyText) as unknown);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"findings": []}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof globalThis.fetch;

      const client = createReviewClient({
        apiKey: "test-key",
        baseUrl: "https://custom.api.example.com/v1",
        model: "custom-model-7b",
        maxRetries: 0,
      });

      await client.complete("system prompt", "user prompt", 1024);

      expect(capturedUrls.some((url) => url.includes("custom.api.example.com"))).toBe(true);
      expect(capturedBodies.some((body) =>
        typeof body === "object" && body !== null && (body as Record<string, unknown>)["model"] === "custom-model-7b",
      )).toBe(true);
    });
  });
});

describe("mergeUsage", () => {
  it("returns undefined when both inputs are undefined", () => {
    expect(mergeUsage(undefined, undefined)).toBeUndefined();
  });

  it("returns the defined side when one input is undefined", () => {
    const usage: CompletionUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    expect(mergeUsage(usage, undefined)).toEqual(usage);
    expect(mergeUsage(undefined, usage)).toEqual(usage);
  });

  it("sums token counts from both usage values", () => {
    const left: CompletionUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    const right: CompletionUsage = {
      promptTokens: 200,
      completionTokens: 80,
      totalTokens: 280,
    };
    const merged = mergeUsage(left, right);
    expect(merged).toEqual({
      promptTokens: 300,
      completionTokens: 130,
      totalTokens: 430,
    });
  });

  it("handles zero-valued usage correctly", () => {
    const zero: CompletionUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const nonZero: CompletionUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    expect(mergeUsage(zero, nonZero)).toEqual(nonZero);
  });
});

describe("createReviewClient", () => {
  it("returns a ReviewClient instance", () => {
    const client = createReviewClient({ apiKey: "test-key" });
    expect(client).toBeInstanceOf(ReviewClient);
  });
});

describe("completeWithTools", () => {
  let originalFetch: typeof globalThis.fetch;
  let callIndex: number;
  let responses: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    callIndex = 0;
    responses = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  let capturedBodies: unknown[];

  function mockFetchSequence(responseSequence: string[]): void {
    responses = responseSequence;
    capturedBodies = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "{}";
      capturedBodies.push(JSON.parse(bodyText) as unknown);
      const body = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
  }

  const FINDINGS_JSON = '{"findings": []}';
  const TOOL_CALL_RESPONSE = JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_callers", arguments: "{}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  });

  const FINAL_RESPONSE = JSON.stringify({
    choices: [{ message: { role: "assistant", content: FINDINGS_JSON } }],
    usage: { prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 },
  });

  const NO_TOOL_CALL_RESPONSE = JSON.stringify({
    choices: [{ message: { role: "assistant", content: null } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });

  const TOOLS: CompleteWithToolsOptions["tools"] = [{
    type: "function",
    function: {
      name: "get_callers",
      description: "test tool",
      parameters: { type: "object", properties: {} },
    },
  }];

  function noopToolCall(): string {
    return "tool result";
  }

  it("makes a final JSON call even when model calls no tools", async () => {
    mockFetchSequence([NO_TOOL_CALL_RESPONSE, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: noopToolCall, maxTokens: 4096, toolTokenBudget: 15_000,
    });

    expect(result.content).toBe(FINDINGS_JSON);
    expect(callIndex).toBe(2);
  });

  it("executes one round of tool calls then returns final content", async () => {
    mockFetchSequence([TOOL_CALL_RESPONSE, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const toolCallNames: string[] = [];
    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: (name) => { toolCallNames.push(name); return `result for ${name}`; },
      maxTokens: 4096, toolTokenBudget: 15_000,
    });

    expect(toolCallNames).toEqual(["get_callers"]);
    expect(result.content).toBe(FINDINGS_JSON);
  });

  it("handles multiple tool calls in a single round", async () => {
    const multiToolResponse = JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_callers", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "get_callers", arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
    });

    mockFetchSequence([multiToolResponse, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    let toolCallCount = 0;
    await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: () => { toolCallCount++; return "result"; },
      maxTokens: 4096, toolTokenBudget: 15_000,
    });

    expect(toolCallCount).toBe(2);
  });

  it("stops at 5 rounds and forces final call", async () => {
    const fiveToolCalls = Array.from({ length: 5 }, () => TOOL_CALL_RESPONSE);
    mockFetchSequence([...fiveToolCalls, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: noopToolCall, maxTokens: 4096, toolTokenBudget: 100_000,
    });

    expect(result.content).toBe(FINDINGS_JSON);
    expect(callIndex).toBe(6);
  });

  it("stops when token budget is exceeded mid-loop", async () => {
    const highTokenResponse = JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_callers", arguments: "{}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5000, completion_tokens: 5000, total_tokens: 10000 },
    });

    mockFetchSequence([highTokenResponse, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: noopToolCall, maxTokens: 4096, toolTokenBudget: 5000,
    });

    expect(result.content).toBe(FINDINGS_JSON);
    expect(callIndex).toBe(2);
  });

  it("skips tool rounds entirely when budget is zero", async () => {
    mockFetchSequence([TOOL_CALL_RESPONSE, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    let toolCalled = false;
    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: () => { toolCalled = true; return "result"; },
      maxTokens: 4096, toolTokenBudget: 0,
    });

    expect(toolCalled).toBe(false);
    expect(result.content).toBe(FINDINGS_JSON);
  });

  it("propagates network errors from the first tool round", async () => {
    globalThis.fetch = (() => {
      return Promise.reject(new Error("network failure"));
    }) as unknown as typeof globalThis.fetch;

    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const promise = client.completeWithTools({
      systemPrompt: "system",
      userPrompt: "user",
      tools: TOOLS,
      onToolCall: noopToolCall,
      maxTokens: 4096,
      toolTokenBudget: 15_000,
    });

    expect(promise).rejects.toThrow();
    await promise.catch(() => {});
  });

  it("aggregates usage across all rounds including final call", async () => {
    const noToolCallBreak = JSON.stringify({
      choices: [{ message: { role: "assistant", content: null } }],
      usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
    });

    mockFetchSequence([TOOL_CALL_RESPONSE, noToolCallBreak, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    const result = await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: noopToolCall, maxTokens: 4096, toolTokenBudget: 15_000,
    });

    expect(result.usage).toBeDefined();
    expect(result.usage!.promptTokens).toBe(200 + 150 + 300);
    expect(result.usage!.completionTokens).toBe(30 + 20 + 50);
    expect(result.usage!.totalTokens).toBe(230 + 170 + 350);
  });

  it("truncates tool output that exceeds MAX_TOOL_OUTPUT_CHARS", async () => {
    mockFetchSequence([TOOL_CALL_RESPONSE, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: () => "x".repeat(100_000),
      maxTokens: 4096, toolTokenBudget: 15_000,
    });

    const secondCall = capturedBodies[1] as { messages: { role: string; content: string }[] };
    const toolMessage = secondCall.messages.find(
      (message: { role: string }) => message.role === "tool",
    );
    expect(toolMessage?.content.length).toBeLessThan(70_000);
    expect(toolMessage?.content).toContain("…[truncated]");
  });

  it("sends synthetic responses for tool calls beyond the per-round cap", async () => {
    const manyToolCalls = Array.from({ length: 15 }, (_, index) => ({
      id: `call_${index}`,
      type: "function" as const,
      function: { name: "get_callers", arguments: "{}" },
    }));
    const overflowResponse = JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: manyToolCalls,
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
    });

    mockFetchSequence([overflowResponse, FINAL_RESPONSE]);
    const client = createReviewClient({ apiKey: "test-key", maxRetries: 0 });

    let toolCallCount = 0;
    await client.completeWithTools({
      systemPrompt: "system", userPrompt: "user", tools: TOOLS,
      onToolCall: () => { toolCallCount++; return "result"; },
      maxTokens: 4096, toolTokenBudget: 15_000,
    });

    expect(toolCallCount).toBe(10);

    const secondCall = capturedBodies[1] as { messages: { role: string; content: string; tool_call_id?: string }[] };
    const toolMessages = secondCall.messages.filter(
      (message: { role: string }) => message.role === "tool",
    );
    expect(toolMessages.length).toBe(15);

    const skippedMessages = toolMessages.filter(
      (message: { content: string }) => message.content.includes("Skipped"),
    );
    expect(skippedMessages.length).toBe(5);
  });
});
