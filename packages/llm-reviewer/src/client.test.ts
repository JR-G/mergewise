import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { ReviewClient, createReviewClient, mergeUsage } from "./client";
import type { CompletionUsage, ReviewClientConfig } from "./client";

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
