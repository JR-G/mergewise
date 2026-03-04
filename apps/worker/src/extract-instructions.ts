import type { ReviewThreadWithReplies } from "@mergewise/github-client";
import type { RepoInstruction } from "@mergewise/feedback-store";
import { sanitiseInstruction } from "@mergewise/feedback-store";

/**
 * Matches the `mergewise-meta` HTML comment marker embedded in PR review comments.
 *
 * Capture groups: (1) ruleId, (2) category.
 */
const META_MARKER_REGEX =
  /mergewise-meta[^>]*ruleId=(\S+)\s+category=(\S+)/;

/**
 * Extracts safe, sanitised instructions from review thread replies.
 *
 * @remarks
 * Only threads where the first comment contains a Mergewise meta marker
 * are considered — these are threads started by Mergewise review comments.
 * Non-bot replies in those threads are treated as candidate instructions.
 *
 * @param threads - Review threads with full comment history.
 * @param repoFullName - Repository full name for the instruction records.
 * @param prNumber - Pull request number for provenance tracking.
 * @returns Sanitised instruction records ready for storage.
 */
export function extractInstructionsFromThreads(
  threads: readonly ReviewThreadWithReplies[],
  repoFullName: string,
  prNumber: number,
): RepoInstruction[] {
  const instructions: RepoInstruction[] = [];
  const now = new Date().toISOString();

  for (const thread of threads) {
    if (thread.comments.length === 0) {
      continue;
    }

    const firstComment = thread.comments[0];
    if (!firstComment) {
      continue;
    }
    const metaMatch = META_MARKER_REGEX.exec(firstComment.body);
    if (!metaMatch) {
      continue;
    }

    const ruleId = metaMatch[1] ?? null;
    const category = metaMatch[2] ?? null;

    for (let commentIndex = 1; commentIndex < thread.comments.length; commentIndex++) {
      const reply = thread.comments[commentIndex];
      if (!reply || reply.authorIsBot) {
        continue;
      }

      const result = sanitiseInstruction(reply.body);
      if (!result.safe) {
        continue;
      }

      instructions.push({
        repoFullName,
        instruction: result.text,
        ruleId,
        category,
        sourcePrNumber: prNumber,
        createdAt: now,
      });
    }
  }

  return instructions;
}
