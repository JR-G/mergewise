/**
 * Typed catalogue of TS/React anti-patterns for the LLM reviewer.
 *
 * @remarks
 * Each entry includes `badExample`/`goodExample` for maintainer reference and a
 * compact `detectionHint` that is injected into the system prompt. The examples
 * are NOT sent to the LLM — only `id`, `title`, `category`, `principle`, and
 * `detectionHint` are serialised into the prompt as a markdown table.
 */

export type { AntiPattern } from "./anti-pattern-types";
export { CLEAN_PATTERNS } from "./clean-patterns";
export { IDIOMATIC_PATTERNS } from "./idiomatic-patterns";
export { SAFETY_PATTERNS } from "./safety-patterns";
export { PERF_PATTERNS } from "./perf-patterns";

import { CLEAN_PATTERNS } from "./clean-patterns";
import { IDIOMATIC_PATTERNS } from "./idiomatic-patterns";
import { SAFETY_PATTERNS } from "./safety-patterns";
import { PERF_PATTERNS } from "./perf-patterns";

/**
 * Canonical registry of all TS/React anti-patterns known to the reviewer.
 *
 * @remarks
 * Consumed by {@link buildSystemPrompt} to inject a detection reference table
 * into the LLM system prompt. The array is frozen at module level — treat it
 * as immutable.
 */
export const ANTI_PATTERNS: readonly import("./anti-pattern-types").AntiPattern[] = [
  ...CLEAN_PATTERNS,
  ...IDIOMATIC_PATTERNS,
  ...SAFETY_PATTERNS,
  ...PERF_PATTERNS,
];
