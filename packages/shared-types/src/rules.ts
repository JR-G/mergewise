import type { Finding, FindingCategory } from "./findings";

/**
 * A single hunk from a unified diff.
 */
export interface DiffHunk {
  /** Unified diff hunk header (e.g. `@@ -10,5 +10,7 @@`). */
  readonly header: string;
  /** Raw lines of the hunk including `+`, `-`, and context prefixes. */
  readonly lines: readonly string[];
}

/**
 * Parsed diff representation for a single file in a pull request.
 */
export interface FileDiff {
  /** File path relative to repository root. */
  readonly filePath: string;
  /** Previous file path when the file was renamed, or `null`. */
  readonly previousPath: string | null;
  /** Parsed hunks from the unified diff. */
  readonly hunks: readonly DiffHunk[];
}

/**
 * Metadata about the pull request being analysed.
 */
export interface PullRequestMetadata {
  /** Repository full name in `owner/name` format. */
  readonly repo: string;
  /** Pull request number. */
  readonly prNumber: number;
  /** Head commit SHA of the pull request. */
  readonly headSha: string;
  /** GitHub App installation identifier for API token resolution. */
  readonly installationId: number | null;
}

/**
 * Context provided to every rule during analysis.
 *
 * @remarks
 * Contains the parsed diffs and PR metadata. Both stateless and codebase-aware
 * rules receive this as their first argument.
 */
export interface AnalysisContext {
  /** Parsed file diffs from the pull request. */
  readonly diffs: readonly FileDiff[];
  /** Pull request metadata for attribution and API calls. */
  readonly pullRequest: PullRequestMetadata;
}

/**
 * Known symbol kinds for the codebase index.
 *
 * @remarks
 * The `string & {}` branch preserves autocomplete for known kinds while
 * allowing language adapters to introduce additional kinds without a
 * shared-types release.
 */
export type SymbolKind =
  | "function"
  | "class"
  | "type"
  | "interface"
  | "variable"
  | "constant"
  | (string & {});

/**
 * An entry in the codebase symbol index.
 */
export interface SymbolEntry {
  /** Symbol name as it appears in source. */
  readonly name: string;
  /** Symbol kind. */
  readonly kind: SymbolKind;
  /** File path relative to repository root. */
  readonly file: string;
  /** One-indexed line number of the symbol declaration. */
  readonly line: number;
  /** Whether the symbol is exported from its module. */
  readonly exported: boolean;
}

/**
 * Extended context for rules that need repository-wide awareness.
 *
 * @remarks
 * Only built when at least one registered rule has `kind: "codebase-aware"`.
 * The runner can skip this expensive step when only stateless rules are present.
 */
export interface CodebaseContext {
  /** Indexed symbols from the repository. */
  readonly symbols: readonly SymbolEntry[];
  /** Repository convention key-value pairs (e.g. naming patterns, framework idioms). */
  readonly conventions: ReadonlyMap<string, string>;
  /**
   * Reads a file from the repository by relative path.
   *
   * @param relativePath - File path relative to repository root.
   * @returns File contents as a string, or `null` if the file does not exist.
   */
  readonly readFile: (relativePath: string) => Promise<string | null>;
}

/**
 * Metadata describing a rule for registration and filtering.
 */
export interface RuleMetadata {
  /** Unique rule identifier (e.g. `"ts-react/exhaustive-deps-missing"`). */
  readonly ruleId: string;
  /** Human-readable rule name. */
  readonly name: string;
  /** Review focus category. */
  readonly category: FindingCategory;
  /** Languages this rule applies to (e.g. `["typescript"]`). */
  readonly languages: readonly string[];
  /** Short description of what the rule detects. */
  readonly description: string;
}

/**
 * A rule that operates only on diff context without needing repository-wide state.
 *
 * @remarks
 * Stateless rules are cheaper to run because the runner does not need to build
 * a codebase index. Prefer this kind unless repository-wide awareness is required.
 */
export interface StatelessRule {
  /** Discriminant for the rule union. */
  readonly kind: "stateless";
  /** Rule metadata for registration and filtering. */
  readonly metadata: RuleMetadata;
  /**
   * Analyses pull request diffs and returns findings.
   *
   * @param context - Parsed diffs and PR metadata.
   * @returns Findings produced by this rule.
   */
  readonly analyse: (
    context: AnalysisContext,
  ) => Promise<readonly Finding[]>;
}

/**
 * A rule that requires repository-wide context in addition to diff context.
 *
 * @remarks
 * Codebase-aware rules trigger symbol indexing and convention detection.
 * Use this kind when the rule needs to reference symbols, conventions,
 * or file contents outside the changed hunks.
 */
export interface CodebaseAwareRule {
  /** Discriminant for the rule union. */
  readonly kind: "codebase-aware";
  /** Rule metadata for registration and filtering. */
  readonly metadata: RuleMetadata;
  /**
   * Analyses pull request diffs with repository-wide context.
   *
   * @param context - Parsed diffs and PR metadata.
   * @param codebaseContext - Symbol index, conventions, and file reader.
   * @returns Findings produced by this rule.
   */
  readonly analyse: (
    context: AnalysisContext,
    codebaseContext: CodebaseContext,
  ) => Promise<readonly Finding[]>;
}

/**
 * Discriminated union of all rule kinds.
 *
 * @remarks
 * The `kind` discriminant allows the runner to determine at registration time
 * whether expensive codebase indexing is required for the current rule set.
 */
export type Rule = StatelessRule | CodebaseAwareRule;
