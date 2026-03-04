/**
 * Maximum permitted instruction length in characters.
 *
 * @remarks
 * Real feedback is short ("we don't care about SRP in test files").
 * Prompt injection payloads tend to be much longer.
 */
const MAX_INSTRUCTION_LENGTH = 500;

/**
 * Patterns that indicate a prompt injection attempt.
 *
 * @remarks
 * Each pattern is tested case-insensitively against the instruction text.
 * Matches cause the instruction to be rejected before storage.
 */
const BLOCKLIST_PATTERNS: readonly RegExp[] = [
  /ignore\s+previous/i,
  /ignore\s+above/i,
  /ignore\s+all/i,
  /disregard/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /new\s+instructions/i,
  /override/i,
  /do\s+not\s+review/i,
  /mark\s+all/i,
  /zero\s+findings/i,
  /no\s+findings/i,
  /forget\s+everything/i,
  /reset\s+context/i,
];

/**
 * Maximum number of newline characters permitted in an instruction.
 */
const MAX_NEWLINES = 3;

/**
 * Result when the instruction passes all sanitisation checks.
 */
export interface SanitiseResultSafe {
  readonly safe: true;
  readonly text: string;
}

/**
 * Result when the instruction is rejected by sanitisation.
 */
export interface SanitiseResultUnsafe {
  readonly safe: false;
  readonly reason: string;
}

/**
 * Discriminated union returned by {@link sanitiseInstruction}.
 */
export type SanitiseResult = SanitiseResultSafe | SanitiseResultUnsafe;

/**
 * Validates and sanitises a candidate instruction extracted from a review thread reply.
 *
 * @remarks
 * Three defence layers are applied in order:
 *
 * 1. **Length cap** — rejects instructions exceeding {@link MAX_INSTRUCTION_LENGTH} characters.
 * 2. **Blocklist filter** — rejects instructions matching known prompt injection patterns.
 * 3. **Structural checks** — rejects instructions with excessive newlines or markdown headers
 *    that could break prompt structure.
 *
 * @param rawText - The raw instruction text from the user's reply.
 * @returns A discriminated result indicating whether the instruction is safe for storage.
 */
export function sanitiseInstruction(rawText: string): SanitiseResult {
  const trimmed = rawText.trim();

  if (trimmed.length === 0) {
    return { safe: false, reason: "empty" };
  }

  if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
    return { safe: false, reason: "exceeds_length_cap" };
  }

  for (const pattern of BLOCKLIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: "blocklist_match" };
    }
  }

  const newlineCount = (trimmed.match(/\n/g) ?? []).length;
  if (newlineCount > MAX_NEWLINES) {
    return { safe: false, reason: "excessive_newlines" };
  }

  if (/^#{1,6}\s/m.test(trimmed)) {
    return { safe: false, reason: "markdown_header" };
  }

  return { safe: true, text: trimmed };
}
