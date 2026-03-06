/**
 * Compiled learning signals derived from historical reviewer feedback for a repository.
 */
export interface RepoLearnings {
  /**
   * Natural language instructions from maintainer replies to review comments.
   */
  readonly instructions: readonly string[];
  /**
   * Rule identifiers with strong negative reaction signals (hard-filtered in delivery).
   */
  readonly suppressedRules: readonly string[];
  /**
   * Finding categories with net positive reaction sentiment.
   */
  readonly preferredCategories: readonly string[];
  /**
   * Finding categories with net negative reaction sentiment.
   */
  readonly dislikedCategories: readonly string[];
  /**
   * Human-readable summary of learnings for prompt context.
   */
  readonly summary: string;
}
