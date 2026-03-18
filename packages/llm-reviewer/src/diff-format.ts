import type { DiffHunk } from "@mergewise/shared-types";

/**
 * Formats diff hunks with explicit line numbers on added/context lines.
 *
 * @remarks
 * Prefixes each added (`+`) and context (` `) line with its 1-indexed
 * new-file line number so the LLM does not need to compute offsets from
 * the hunk header. Removed (`-`) lines are emitted without a number.
 *
 * @param hunks - Diff hunks to format.
 * @returns Formatted diff string with line numbers.
 */
export function formatNumberedDiff(hunks: readonly DiffHunk[]): string {
  return hunks.map(formatNumberedHunk).join("\n\n");
}

function formatNumberedHunk(hunk: DiffHunk): string {
  const startLine = parseNewFileStart(hunk.header);
  const numberedLines: string[] = [];
  let currentLine = startLine;

  for (const line of hunk.lines) {
    if (line.startsWith("-") || line.startsWith("\\")) {
      numberedLines.push(line);
      continue;
    }

    if (line.startsWith("+") || line.startsWith(" ")) {
      const prefix = line[0];
      const content = line.slice(1);
      numberedLines.push(`${prefix}${String(currentLine).padStart(4)} ${content}`);
      currentLine++;
      continue;
    }

    numberedLines.push(line);
    currentLine++;
  }

  return `${hunk.header}\n${numberedLines.join("\n")}`;
}

function parseNewFileStart(header: string): number {
  const match = /\+(\d+)/.exec(header);
  if (!match?.[1]) return 1;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
