/**
 * Returns true when task markdown still contains unresolved goal placeholders.
 *
 * @param taskFileContents - Markdown content of a task file.
 * @returns Whether the goal section is unresolved.
 */
export function hasPlaceholderGoal(taskFileContents: string): boolean {
  return (
    taskFileContents.includes("Describe exactly what this task must deliver.") ||
    taskFileContents.includes("<goal>")
  );
}

/**
 * Extracts the goal section text from a task markdown document.
 *
 * @param taskFileContents - Markdown content of a task file.
 * @returns Goal section text when found.
 */
export function extractTaskGoal(taskFileContents: string): string | null {
  const goalSectionMatch = /## Goal\s+([\s\S]*?)(?:\n## |$)/.exec(taskFileContents);
  if (!goalSectionMatch) {
    return null;
  }

  const goalText = (goalSectionMatch[1] ?? "").trim();
  if (!goalText) {
    return null;
  }

  return goalText.replace(/\s+/g, " ");
}
