import OpenAI from "openai";

/**
 * Configuration for the LLM review client.
 */
export interface ReviewClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly model?: string | undefined;
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
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
 * Options for a multi-turn tool-calling completion.
 */
export interface CompleteWithToolsOptions {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tools: OpenAI.ChatCompletionTool[];
  readonly onToolCall: (toolName: string, args: string) => string;
  readonly maxTokens: number;
  readonly toolTokenBudget: number;
  readonly temperature?: number | undefined;
}

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_CALLS_PER_ROUND = 10;

/**
 * Extracts token usage from an OpenAI response into our internal format.
 */
function extractUsage(
  response: OpenAI.ChatCompletion,
): CompletionUsage | undefined {
  if (!response.usage) return undefined;
  return {
    promptTokens: response.usage.prompt_tokens,
    completionTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
  };
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
    this.model = config.model ?? "gpt-4.1";
  }

  /**
   * Sends a chat completion request and returns the response with token usage.
   *
   * @param systemPrompt - System message setting the reviewer persona.
   * @param userPrompt - User message with diff and file context.
   * @param maxTokens - Maximum tokens in the response.
   * @param temperature - Sampling temperature (defaults to 0.2).
   * @returns Content and token usage from the model response.
   */
  async complete(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    temperature = 0.2,
  ): Promise<CompletionResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content;
    if (!content) {
      throw new Error("LLM returned empty response");
    }

    return { content, usage: extractUsage(response) };
  }

  /**
   * Sends a multi-turn chat completion with tool calling, then forces a
   * final JSON response once tools are exhausted.
   *
   * @remarks
   * Tool rounds omit `response_format` to avoid conflicts with providers
   * that reject structured output when tools are active. A final call with
   * `response_format: { type: "json_object" }` and no tools forces the
   * model to produce JSON findings.
   *
   * The loop terminates when any of:
   * - The model returns no tool_calls (done voluntarily)
   * - `MAX_TOOL_ROUNDS` (5) reached
   * - `toolTokenBudget` exceeded
   *
   * `toolTokenBudget` is a soft per-round limit: the budget check runs
   * after each round completes, so one round's tool calls may push
   * cumulative usage past the budget before the loop breaks. At most
   * `MAX_TOOL_CALLS_PER_ROUND` (10) tool calls are processed per round;
   * any excess calls from the model are silently dropped.
   */
  async completeWithTools(options: CompleteWithToolsOptions): Promise<CompletionResult> {
    const {
      systemPrompt, userPrompt, tools, onToolCall,
      maxTokens, toolTokenBudget, temperature = 0.2,
    } = options;
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let cumulativeUsage: CompletionUsage | undefined;
    let cumulativeTokens = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools,
        max_completion_tokens: maxTokens,
        temperature,
      });

      cumulativeUsage = mergeUsage(cumulativeUsage, extractUsage(response));
      cumulativeTokens += response.usage?.total_tokens ?? 0;

      const assistantMessage = response.choices[0]?.message;
      if (!assistantMessage) {
        throw new Error("LLM returned empty response during tool round");
      }

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        break;
      }

      if (cumulativeTokens >= toolTokenBudget) {
        break;
      }

      messages.push(assistantMessage);
      const cappedToolCalls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      for (const toolCall of cappedToolCalls) {
        if (toolCall.type !== "function") continue;
        const result = onToolCall(
          toolCall.function.name,
          toolCall.function.arguments,
        );
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    const finalResponse = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_completion_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
    });

    cumulativeUsage = mergeUsage(cumulativeUsage, extractUsage(finalResponse));

    const content = finalResponse.choices[0]?.message.content;
    if (!content) {
      throw new Error("LLM returned empty response in final JSON call");
    }

    return { content, usage: cumulativeUsage };
  }
}

/**
 * Merges two optional usage values into one.
 *
 * @param left - First usage value.
 * @param right - Second usage value.
 * @returns Combined usage, or undefined if both inputs are undefined.
 */
export function mergeUsage(
  left: CompletionUsage | undefined,
  right: CompletionUsage | undefined,
): CompletionUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
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
