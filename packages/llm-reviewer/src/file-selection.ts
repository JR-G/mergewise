import picomatch from "picomatch";
import type { FileDiff } from "@mergewise/shared-types";

const SKIP_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /test-helpers?\.[tj]sx?$/,
  /test-utils?\.[tj]sx?$/,
  /__tests__\//,
  /\/fixtures\//,
  /\/fixture\//,
  /\.config\.[tj]sx?$/,
  /\.config\.[cm]?[jt]s$/,
  /\.eslintrc/,
  /tsconfig.*\.json$/,
  /\.prettierrc/,
  /\.babelrc/,
  /jest\.config/,
  /vitest\.config/,
  /vite\.config/,
  /next\.config/,
  /tailwind\.config/,
  /postcss\.config/,
  /webpack\.config/,
  /rollup\.config/,
  /package-lock\.json$/,
  /bun\.lock$/,
  /bun\.lockb$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.generated\./,
  /\.d\.ts$/,
  /\.snap$/,
  /\.svg$/,
  /\.png$/,
  /\.jpg$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.map$/,
];

const matcherCache = new Map<string, picomatch.Matcher>();

function getCachedMatcher(patterns: readonly string[]): picomatch.Matcher {
  const cacheKey = patterns.join("\0");
  const cached = matcherCache.get(cacheKey);
  if (cached) return cached;
  const matcher = picomatch(patterns as string[]);
  matcherCache.set(cacheKey, matcher);
  return matcher;
}

const TS_EXTENSIONS = /\.[tj]sx?$/;

const TOKENS_PER_LINE = 4;

/**
 * Counts added lines across all hunks in a file diff.
 */
export function countAddedLines(diff: FileDiff): number {
  let count = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Estimates token usage for a file diff based on its hunk content.
 */
export function estimateTokens(diff: FileDiff): number {
  let lineCount = 0;
  for (const hunk of diff.hunks) {
    lineCount += hunk.lines.length;
  }
  return lineCount * TOKENS_PER_LINE;
}

/**
 * Returns true when a file path matches any built-in or user-defined skip pattern.
 *
 * @param filePath - File path to check.
 * @param userSkipPatterns - Optional glob patterns from user config.
 */
export function shouldSkipFile(filePath: string, userSkipPatterns?: readonly string[]): boolean {
  if (SKIP_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return true;
  }

  if (userSkipPatterns && userSkipPatterns.length > 0) {
    return getCachedMatcher(userSkipPatterns)(filePath);
  }

  return false;
}

/**
 * Returns true when a file path has a TypeScript or JavaScript extension.
 */
export function isTypeScriptFile(filePath: string): boolean {
  return TS_EXTENSIONS.test(filePath);
}

/**
 * Selects files for LLM review from a set of diffs.
 *
 * @remarks
 * Filters out test files, config, lockfiles, generated files, and non-TS files.
 * Prioritises by number of added lines (descending), with `.tsx` files ranked
 * above `.ts` files at equal change volume. Respects the token budget by
 * estimating ~4 tokens per diff line and stopping when the budget is exhausted.
 *
 * @param diffs - File diffs from the pull request.
 * @param tokenBudget - Maximum estimated tokens across all selected files.
 * @param userSkipPatterns - Optional glob patterns from user config.
 * @returns Selected file diffs in priority order.
 */
export function selectFilesForReview(
  diffs: readonly FileDiff[],
  tokenBudget: number,
  userSkipPatterns?: readonly string[],
): FileDiff[] {
  const candidates = diffs.filter(
    (diff) => isTypeScriptFile(diff.filePath) && !shouldSkipFile(diff.filePath, userSkipPatterns),
  );

  const sorted = [...candidates].sort((left, right) => {
    const addedLeft = countAddedLines(left);
    const addedRight = countAddedLines(right);
    if (addedRight !== addedLeft) {
      return addedRight - addedLeft;
    }
    const isTsxLeft = left.filePath.endsWith(".tsx") ? 1 : 0;
    const isTsxRight = right.filePath.endsWith(".tsx") ? 1 : 0;
    return isTsxRight - isTsxLeft;
  });

  const selected: FileDiff[] = [];
  let consumed = 0;

  for (const diff of sorted) {
    const cost = estimateTokens(diff);
    if (consumed + cost > tokenBudget && selected.length > 0) {
      break;
    }
    selected.push(diff);
    consumed += cost;
  }

  return selected;
}
