import OpenAI from "openai";

/**
 * Configuration for the LLM review client.
 */
export interface ReviewClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

/**
 * Token usage statistics from a single LLM completion.
 */
export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * Result of a chat completion including content and token usage.
 */
export interface CompletionResult {
  readonly content: string;
  readonly usage: CompletionUsage | undefined;
}

/**
 * Thin wrapper over an OpenAI-compatible API client.
 *
 * @remarks
 * Works with any provider that exposes the OpenAI chat completions API:
 * OpenAI, Anthropic (via their OpenAI-compatible endpoint), Ollama,
 * OpenRouter, Together, etc.
 */
export class ReviewClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: ReviewClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      maxRetries: config.maxRetries ?? 3,
      timeout: config.timeoutMs ?? 60_000,
    });
    this.model = config.model ?? "gpt-4o";
  }

  /**
   * Sends a chat completion request and returns the response with token usage.
   *
   * @param systemPrompt - System message setting the reviewer persona.
   * @param userPrompt - User message with diff and file context.
   * @param maxTokens - Maximum tokens in the response.
   * @returns Content and token usage from the model response.
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
  ): Promise<CompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: maxTokens,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error("LLM returned empty response");
    }

    const usage: CompletionUsage | undefined = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    return { content, usage };
  }
}

/**
 * Creates a review client from configuration.
 *
 * @param config - Client configuration with API key and optional provider settings.
 * @returns Configured review client instance.
 */
export function createReviewClient(config: ReviewClientConfig): ReviewClient {
  return new ReviewClient(config);
}
