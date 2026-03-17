/**
 * Branded (nominal) types for domain values.
 *
 * @remarks
 * Branded types add type-level safety to primitive values by tagging them with
 * a phantom property that exists only at compile time. TypeScript will reject
 * assignments between branded types even when the underlying primitive is the
 * same, preventing accidental misuse (e.g. passing a file path where a repo
 * name is expected).
 *
 * **Convention:** validate at system boundaries (webhook handlers, queue
 * parsers, LLM response parsers, config loaders, test fixtures) using the
 * constructor functions below. Internal functions accept and return branded
 * types with no re-validation.
 *
 * **Adding a new branded type:**
 * 1. Define a type alias using {@link Brand}.
 * 2. Export a throwing constructor that validates and casts.
 * 3. Export a `tryParse` variant returning `T | null` for type-guard use.
 * 4. Add colocated tests in `branded.test.ts`.
 * 5. Update the lefthook `no-raw-domain-types` hook if the field name is new.
 */

import { randomUUID } from "node:crypto";

declare const __brand: unique symbol;

/**
 * Tags a base type `T` with a compile-time-only brand `B`.
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/**
 * Relative file path within a repository (non-empty, no leading `/`).
 */
export type FilePath = Brand<string, "FilePath">;

/**
 * Repository full name in `owner/repo` format.
 */
export type RepoFullName = Brand<string, "RepoFullName">;

/**
 * Full 40-character lowercase hexadecimal commit SHA.
 */
export type SHA = Brand<string, "SHA">;

/**
 * UUID-formatted scan identifier for the debt scanner.
 */
export type ScanId = Brand<string, "ScanId">;

/**
 * UUID-formatted queue job identifier.
 */
export type JobId = Brand<string, "JobId">;

/**
 * Rule identifier in `namespace/name` format.
 */
export type RuleId = Brand<string, "RuleId">;

/**
 * Confidence score between 0 and 1 inclusive.
 */
export type Confidence = Brand<number, "Confidence">;

/**
 * One-indexed positive integer line number.
 */
export type LineNumber = Brand<number, "LineNumber">;

/**
 * Positive integer pull request number.
 */
export type PRNumber = Brand<number, "PRNumber">;

/**
 * Positive integer GitHub App installation identifier.
 */
export type InstallationId = Brand<number, "InstallationId">;

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO_FULL_NAME_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const RULE_ID_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function containsParentTraversal(value: string): boolean {
  return value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..");
}

/**
 * Creates a {@link FilePath} from a raw string.
 *
 * @throws TypeError when the value is empty or starts with `/`.
 */
export function toFilePath(value: string): FilePath {
  if (value.length === 0) {
    throw new TypeError("FilePath must be non-empty");
  }
  if (value.startsWith("/")) {
    throw new TypeError("FilePath must be relative (no leading '/')");
  }
  if (value.includes("\\")) {
    throw new TypeError("FilePath must not contain backslashes");
  }
  if (containsParentTraversal(value)) {
    throw new TypeError("FilePath must not contain parent directory traversal");
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw new TypeError("FilePath must not be a Windows absolute path");
  }
  return value as FilePath;
}

/**
 * Attempts to parse a raw string as a {@link FilePath}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseFilePath(value: string): FilePath | null {
  if (value.length === 0 || value.startsWith("/")) return null;
  if (value.includes("\\")) return null;
  if (containsParentTraversal(value)) return null;
  if (/^[A-Za-z]:/.test(value)) return null;
  return value as FilePath;
}

/**
 * Creates a {@link RepoFullName} from a raw string.
 *
 * @throws TypeError when the value does not match `owner/repo` format.
 */
export function toRepoFullName(value: string): RepoFullName {
  if (!REPO_FULL_NAME_PATTERN.test(value)) {
    throw new TypeError(
      `RepoFullName must match owner/repo format, got "${value}"`,
    );
  }
  return value as RepoFullName;
}

/**
 * Attempts to parse a raw string as a {@link RepoFullName}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseRepoFullName(value: string): RepoFullName | null {
  if (!REPO_FULL_NAME_PATTERN.test(value)) return null;
  return value as RepoFullName;
}

/**
 * Creates a {@link SHA} from a raw string.
 *
 * @throws TypeError when the value is not exactly 40 lowercase hex characters.
 */
export function toSHA(value: string): SHA {
  if (!SHA_PATTERN.test(value)) {
    throw new TypeError(
      `SHA must be exactly 40 lowercase hex characters, got "${value}"`,
    );
  }
  return value as SHA;
}

/**
 * Attempts to parse a raw string as a {@link SHA}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseSHA(value: string): SHA | null {
  if (!SHA_PATTERN.test(value)) return null;
  return value as SHA;
}

/**
 * Creates a {@link ScanId} from a raw string.
 *
 * @throws TypeError when the value is not a valid UUID.
 */
export function toScanId(value: string): ScanId {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`ScanId must be a valid UUID, got "${value}"`);
  }
  return value as ScanId;
}

/**
 * Attempts to parse a raw string as a {@link ScanId}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseScanId(value: string): ScanId | null {
  if (!UUID_PATTERN.test(value)) return null;
  return value as ScanId;
}

/**
 * Generates a new random {@link ScanId}.
 */
export function generateScanId(): ScanId {
  return toScanId(randomUUID());
}

/**
 * Creates a {@link JobId} from a raw string.
 *
 * @throws TypeError when the value is not a valid UUID.
 */
export function toJobId(value: string): JobId {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`JobId must be a valid UUID, got "${value}"`);
  }
  return value as JobId;
}

/**
 * Attempts to parse a raw string as a {@link JobId}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseJobId(value: string): JobId | null {
  if (!UUID_PATTERN.test(value)) return null;
  return value as JobId;
}

/**
 * Generates a new random {@link JobId}.
 */
export function generateJobId(): JobId {
  return toJobId(randomUUID());
}

/**
 * Creates a {@link RuleId} from a raw string.
 *
 * @throws TypeError when the value does not match `namespace/name` format.
 */
export function toRuleId(value: string): RuleId {
  if (!RULE_ID_PATTERN.test(value)) {
    throw new TypeError(
      `RuleId must match namespace/name format (lowercase, hyphens, dots, underscores), got "${value}"`,
    );
  }
  return value as RuleId;
}

/**
 * Attempts to parse a raw string as a {@link RuleId}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseRuleId(value: string): RuleId | null {
  if (!RULE_ID_PATTERN.test(value)) return null;
  return value as RuleId;
}

/**
 * Creates a {@link Confidence} from a raw number.
 *
 * @throws TypeError when the value is not finite or outside [0, 1].
 */
export function toConfidence(value: number): Confidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(
      `Confidence must be between 0 and 1 inclusive, got ${value}`,
    );
  }
  return value as Confidence;
}

/**
 * Attempts to parse a raw number as a {@link Confidence}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseConfidence(value: number): Confidence | null {
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value as Confidence;
}

/**
 * Creates a {@link LineNumber} from a raw number.
 *
 * @throws TypeError when the value is not a positive integer.
 */
export function toLineNumber(value: number): LineNumber {
  if (!isPositiveInteger(value)) {
    throw new TypeError(
      `LineNumber must be a positive integer, got ${value}`,
    );
  }
  return value as LineNumber;
}

/**
 * Attempts to parse a raw number as a {@link LineNumber}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseLineNumber(value: number): LineNumber | null {
  if (!isPositiveInteger(value)) return null;
  return value as LineNumber;
}

/**
 * Creates a {@link PRNumber} from a raw number.
 *
 * @throws TypeError when the value is not a positive integer.
 */
export function toPRNumber(value: number): PRNumber {
  if (!isPositiveInteger(value)) {
    throw new TypeError(
      `PRNumber must be a positive integer, got ${value}`,
    );
  }
  return value as PRNumber;
}

/**
 * Attempts to parse a raw number as a {@link PRNumber}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParsePRNumber(value: number): PRNumber | null {
  if (!isPositiveInteger(value)) return null;
  return value as PRNumber;
}

/**
 * Creates an {@link InstallationId} from a raw number.
 *
 * @throws TypeError when the value is not a positive integer.
 */
export function toInstallationId(value: number): InstallationId {
  if (!isPositiveInteger(value)) {
    throw new TypeError(
      `InstallationId must be a positive integer, got ${value}`,
    );
  }
  return value as InstallationId;
}

/**
 * Attempts to parse a raw number as an {@link InstallationId}.
 *
 * @returns The branded value, or `null` if validation fails.
 */
export function tryParseInstallationId(
  value: number,
): InstallationId | null {
  if (!isPositiveInteger(value)) return null;
  return value as InstallationId;
}
