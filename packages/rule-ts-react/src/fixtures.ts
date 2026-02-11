import type { AnalysisContext, DiffHunk, FileDiff } from "@mergewise/shared-types";

const BASE_PULL_REQUEST = {
  repo: "acme/widget",
  prNumber: 42,
  headSha: "abc123def",
  installationId: 99,
};

/**
 * Creates a typed analysis context for tests with deterministic pull request metadata.
 *
 * @param diffs - Diff inputs for rule analysis.
 * @returns Analysis context for invoking rule analysis.
 */
export function makeAnalysisContext(diffs: readonly FileDiff[]): AnalysisContext {
  return {
    diffs,
    pullRequest: BASE_PULL_REQUEST,
  };
}

/**
 * Creates a diff hunk for tests.
 *
 * @param header - Unified diff hunk header.
 * @param lines - Hunk lines including diff prefixes.
 * @returns Typed diff hunk.
 */
export function makeDiffHunk(header: string, lines: readonly string[]): DiffHunk {
  return {
    header,
    lines,
  };
}

/**
 * Creates a file diff for tests.
 *
 * @param filePath - Relative file path.
 * @param hunks - Diff hunks for the file.
 * @returns Typed file diff.
 */
export function makeFileDiff(filePath: string, hunks: readonly DiffHunk[]): FileDiff {
  return {
    filePath,
    previousPath: null,
    hunks,
  };
}
