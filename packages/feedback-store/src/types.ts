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
 * Backend-agnostic persistence layer for PR comment reaction feedback.
 */
export interface FeedbackStore {
  saveFeedback(records: readonly FeedbackRecord[]): void;
  close(): void;
}
