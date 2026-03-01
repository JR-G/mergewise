/**
 * A documented anti-pattern entry for the LLM reviewer catalogue.
 *
 * @remarks
 * Each entry pairs human-readable documentation (`badExample`/`goodExample`)
 * with a compact `detectionHint` that is injected into the system prompt.
 * Only `id`, `title`, `category`, `principle`, and `detectionHint` are
 * serialised into the prompt — the examples are for maintainer reference only.
 */
export interface AntiPattern {
  /** Unique kebab-case identifier, referenced in LLM findings. */
  readonly id: string;
  /** Short human-readable name for the anti-pattern. */
  readonly title: string;
  /** Longer explanation of why this pattern is problematic. */
  readonly description: string;
  /** Review focus area this pattern belongs to. */
  readonly category: "clean" | "idiomatic" | "safety" | "perf";
  /** Languages this pattern applies to. */
  readonly languages: readonly ("typescript" | "react")[];
  /** Illustrative code showing the anti-pattern. Not sent to the LLM. */
  readonly badExample: string;
  /** Refactored alternative. Not sent to the LLM. */
  readonly goodExample: string;
  /** Named principle or rule violated (e.g. "SRP", "DRY"). */
  readonly principle: string;
  /** Compact description injected into the system prompt to guide detection. */
  readonly detectionHint: string;
}
