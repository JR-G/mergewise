/**
 * Parsed goal details extracted from one task markdown document.
 */
export interface TaskGoalAnalysis {
  /**
   * Goal text from the section body when present.
   */
  readonly goalText: string | null;
  /**
   * Whether the goal text is concrete and not a template placeholder.
   */
  readonly isConcreteGoal: boolean;
}

const GOAL_HEADING_PATTERN = /^##\s+Goal\s*$/im;
const NEXT_SECTION_HEADING_PATTERN = /^##\s+/m;
const PLACEHOLDER_GOAL_PATTERN = /describe\s+exactly\s+what\s+this\s+task\s+must\s+deliver\.?/i;

/**
 * Parses the Goal section from one task markdown document.
 *
 * @param markdownContent - Full task markdown text.
 * @returns Goal analysis with raw text and concrete-goal status.
 */
export function analyseTaskGoal(markdownContent: string): TaskGoalAnalysis {
  const extractedGoalText = extractGoalSectionText(markdownContent);
  if (extractedGoalText === null) {
    return {
      goalText: null,
      isConcreteGoal: false,
    };
  }

  return {
    goalText: extractedGoalText,
    isConcreteGoal: isConcreteGoalText(extractedGoalText),
  };
}

/**
 * Determines whether one goal sentence is concrete and actionable.
 *
 * @param goalText - Goal text to evaluate.
 * @returns True when the text is not empty and not a known placeholder.
 */
export function isConcreteGoalText(goalText: string): boolean {
  const normalizedGoalText = goalText.trim();
  if (normalizedGoalText.length === 0) {
    return false;
  }

  return !PLACEHOLDER_GOAL_PATTERN.test(normalizedGoalText);
}

function extractGoalSectionText(markdownContent: string): string | null {
  const goalHeadingMatch = GOAL_HEADING_PATTERN.exec(markdownContent);
  if (!goalHeadingMatch || typeof goalHeadingMatch.index !== "number") {
    return null;
  }

  const sectionStartIndex = goalHeadingMatch.index + goalHeadingMatch[0].length;
  const sectionRemainder = markdownContent.slice(sectionStartIndex);
  const nextSectionMatch = NEXT_SECTION_HEADING_PATTERN.exec(sectionRemainder);
  const sectionBody =
    nextSectionMatch === null
      ? sectionRemainder
      : sectionRemainder.slice(0, nextSectionMatch.index);
  const normalizedSectionBody = sectionBody
    .trim()
    .split("\n")
    .map((lineValue) => lineValue.trim())
    .filter((lineValue) => lineValue.length > 0)
    .join(" ");

  if (normalizedSectionBody.length === 0) {
    return null;
  }

  return normalizedSectionBody;
}
