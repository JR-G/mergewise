import type { ReviewThreadWithReplies } from "@mergewise/github-client";
import type { RepoInstruction } from "@mergewise/feedback-store";
import { sanitiseInstruction } from "@mergewise/feedback-store";

import { MERGEWISE_META_REGEX } from "./comment-formatter";

const MAX_INSTRUCTIONS = 100;

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
  if (!repoFullName || !/^[^/]+\/[^/]+$/.test(repoFullName)) {
    throw new TypeError(`repoFullName must match "owner/repo" format (got "${repoFullName}")`);
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new TypeError(`prNumber must be a positive integer (got ${prNumber})`);
  }

  const instructions: RepoInstruction[] = [];
  const now = new Date().toISOString();

  for (const thread of threads) {
    if (instructions.length >= MAX_INSTRUCTIONS) {
      break;
    }
    if (thread.comments.length === 0) {
      continue;
    }

    const firstComment = thread.comments[0];
    if (!firstComment?.authorIsBot) {
      continue;
    }
    const metaMatch = MERGEWISE_META_REGEX.exec(firstComment.body);
    if (!metaMatch) {
      continue;
    }

    const ruleId = metaMatch[2] ?? null;
    const category = metaMatch[3] ?? null;

    for (let commentIndex = 1; commentIndex < thread.comments.length; commentIndex++) {
      if (instructions.length >= MAX_INSTRUCTIONS) {
        break;
      }
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
