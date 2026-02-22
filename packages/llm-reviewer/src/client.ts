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
   * Sends a chat completion request and returns the raw response text.
   *
   * @param systemPrompt - System message setting the reviewer persona.
   * @param userPrompt - User message with diff and file context.
   * @param maxTokens - Maximum tokens in the response.
   * @returns Raw text from the model's first choice.
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
  ): Promise<string> {
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

    return content;
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
