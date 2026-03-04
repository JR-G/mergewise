/**
 * A single feedback record extracted from a Mergewise PR comment reaction.
 */
export interface FeedbackRecord {
  readonly findingId: string;
  readonly ruleId: string;
  readonly category: string;
  readonly confidence: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly otherReactions: number;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly traceId: string;
  readonly recordedAt: string;
}

/**
 * A natural-language instruction extracted from a review thread reply.
 */
export interface RepoInstruction {
  readonly repoFullName: string;
  readonly instruction: string;
  readonly ruleId: string | null;
  readonly category: string | null;
  readonly sourcePrNumber: number;
  readonly createdAt: string;
}

/**
 * Aggregated thumbs-up/down sentiment for a single rule.
 */
export interface RuleSentiment {
  readonly ruleId: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly totalRecords: number;
}

/**
 * Aggregated thumbs-up/down sentiment for a single category.
 */
export interface CategorySentiment {
  readonly category: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
  readonly totalRecords: number;
}

/**
 * Backend-agnostic persistence layer for PR comment reaction feedback.
 */
export interface FeedbackStore {
  saveFeedback(records: readonly FeedbackRecord[]): void;
  saveInstructions(instructions: readonly RepoInstruction[]): void;
  queryInstructions(repoFullName: string): RepoInstruction[];
  queryRuleSentiment(repoFullName: string): RuleSentiment[];
  queryDislikedCategories(repoFullName: string): CategorySentiment[];
  close(): void;
}
