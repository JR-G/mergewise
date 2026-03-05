import type { RepoLearnings } from "@mergewise/shared-types";
import type { FeedbackStore } from "./types";

/**
 * Ratio threshold for suppressing a rule: thumbs-down must exceed 2x thumbs-up.
 */
const SUPPRESSION_DISLIKE_RATIO = 2;

/**
 * Minimum total reactions (thumbs-up + thumbs-down) before a rule can be suppressed.
 */
const MIN_REACTIONS = 3;

/**
 * Compiles repository-level learnings from stored feedback and instructions.
 *
 * @param repoFullName - Full repository name (e.g. "acme/widget").
 * @param feedbackStore - Feedback store instance to query.
 * @returns Compiled learnings ready for injection into the review pipeline.
 */
export function compileLearnings(
  repoFullName: string,
  feedbackStore: FeedbackStore,
): RepoLearnings {
  const instructions = feedbackStore
    .queryInstructions(repoFullName)
    .map((record) => record.instruction);

  const ruleSentiments = feedbackStore.queryRuleSentiment(repoFullName);
  const suppressedRules = ruleSentiments
    .filter((sentiment) => {
      const totalReactions = sentiment.thumbsUp + sentiment.thumbsDown;
      return totalReactions >= MIN_REACTIONS && sentiment.thumbsDown > sentiment.thumbsUp * SUPPRESSION_DISLIKE_RATIO;
    })
    .map((sentiment) => sentiment.ruleId);

  const categorySentiments = feedbackStore.queryCategorySentiment(repoFullName);

  const preferredCategories: string[] = [];
  const dislikedCategories: string[] = [];
  for (const sentiment of categorySentiments) {
    if (sentiment.thumbsUp > sentiment.thumbsDown) {
      preferredCategories.push(sentiment.category);
    } else if (sentiment.thumbsDown > sentiment.thumbsUp) {
      dislikedCategories.push(sentiment.category);
    }
  }

  const summaryParts: string[] = [];
  if (instructions.length > 0) {
    summaryParts.push(`${instructions.length} instruction(s)`);
  }
  if (suppressedRules.length > 0) {
    summaryParts.push(`${suppressedRules.length} suppressed rule(s)`);
  }
  if (preferredCategories.length > 0) {
    summaryParts.push(`${preferredCategories.length} preferred category/ies`);
  }
  if (dislikedCategories.length > 0) {
    summaryParts.push(`${dislikedCategories.length} disliked category/ies`);
  }

  const summary = summaryParts.length > 0 ? summaryParts.join(", ") : "no learnings";

  return {
    instructions,
    suppressedRules,
    preferredCategories,
    dislikedCategories,
    summary,
  };
}
