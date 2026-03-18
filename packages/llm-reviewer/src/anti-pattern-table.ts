import type { AntiPattern } from "./anti-pattern-types";

const escapePipe = (value: string): string => value.replaceAll("|", "\\|");

/**
 * Builds a markdown reference table from a list of anti-patterns for prompt injection.
 *
 * @param patterns - Anti-patterns to include in the table.
 * @returns Markdown string with table header, rows, and usage instructions.
 *   Returns an empty string when the pattern list is empty.
 */
export function buildAntiPatternReferenceTable(
  patterns: readonly AntiPattern[],
): string {
  if (patterns.length === 0) return "";
  const header =
    "| id | title | category | principle | detectionHint |\n| --- | --- | --- | --- | --- |";
  const rows = patterns.map(
    (pattern) =>
      `| ${escapePipe(pattern.id)} | ${escapePipe(pattern.title)} | ${escapePipe(pattern.category)} | ${escapePipe(pattern.principle)} | ${escapePipe(pattern.detectionHint)} |`,
  );
  return `## Anti-pattern reference (recognition aid — not a checklist)

Use this table to **confirm** a problem you have already identified — do not scan it looking for patterns to match. A detection hint describes executable code structure, not string content, comments, or data objects. When you flag a catalogued pattern, reference its id.

${header}\n${rows.join("\n")}

`;
}
