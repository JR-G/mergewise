import type { Finding } from "@mergewise/shared-types";

/**
 * Matches the `mergewise-meta` HTML comment marker embedded in PR comments.
 *
 * Expected format (whitespace-separated key=value pairs inside an HTML comment):
 * `<!-- mergewise-meta dedupeKey=… findingId=… ruleId=… category=… confidence=… -->`
 *
 * Capture groups: (1) findingId, (2) ruleId, (3) category, (4) confidence.
 */
export const MERGEWISE_META_REGEX =
  /mergewise-meta[^>]*findingId=(\S+)\s+ruleId=(\S+)\s+category=(\S+)\s+confidence=(\S+)/;

/**
 * Builds a Markdown pull request comment for one finding with human-readable context and a collapsible structured payload.
 *
 * @param finding - The finding object used to populate rule, location, evidence, recommendation, and payload fields.
 * @param groupedFindings - All findings grouped by file/rule key.
 * @param dedupeKey - Unique deduplication key included in the structured payload.
 * @returns The full Markdown comment string posted to the pull request.
 *
 * @remarks
 * Stringifies a subset of finding fields with 2-space indentation, includes evidence and recommendation sections,
 * and embeds the payload inside a collapsible `<details>` block.
 */
export function buildStructuredFindingComment(
  finding: Finding,
  groupedFindings: readonly Finding[],
  dedupeKey: string,
): string {
  const recommendation = wrapCodeIdentifiers(finding.recommendation.trim());
  const leadLine = `**${finding.category}**: ${recommendation}`;
  const suggestedRewrite = buildSuggestedRewriteSection(finding);
  const additionalLocations = buildAdditionalLocationsSection(groupedFindings);
  const debugMetadata = buildDebugMetadataSection(finding, dedupeKey);

  return [leadLine, "", ...suggestedRewrite, ...additionalLocations, debugMetadata].join("\n");
}

/**
 * Wraps code identifiers (camelCase, PascalCase, snake_case with dots/hashes)
 * in backtick code spans when not already inside backticks.
 *
 * @param text - Recommendation text that may contain bare code identifiers.
 * @returns Text with code identifiers wrapped in backticks.
 */
export function wrapCodeIdentifiers(text: string): string {
  return text.replace(
    /`[^`]+`|'([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)'|(?<![`\w])([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)(?![`\w])/g,
    (match, singleQuoted: string | undefined, bareIdentifier: string | undefined) => {
      const identifier = singleQuoted ?? bareIdentifier;
      if (identifier === undefined) {
        return match;
      }

      if (!isCamelCaseOrPascalCase(identifier)) {
        return match;
      }

      return `\`${identifier}\``;
    },
  );
}

export function isCamelCaseOrPascalCase(identifier: string): boolean {
  const segments = identifier.split(".");
  return segments.some((segment) => {
    if (segment.length < 2) {
      return false;
    }

    return /[a-z][A-Z]/.test(segment);
  });
}

/**
 * Builds the suggested rewrite section when a patch preview is available.
 *
 * @param finding - Finding that may include a patch preview.
 * @returns Markdown lines for the suggested rewrite section.
 */
export function buildSuggestedRewriteSection(finding: Finding): readonly string[] {
  const patchPreview = finding.patchPreview;
  if (!patchPreview || patchPreview.addedLines.length === 0) {
    return [];
  }

  const normalizedLanguage = finding.language.toLowerCase();
  const fencedLanguage = normalizedLanguage === "typescriptreact" ? "tsx" : normalizedLanguage;
  const addedLines = patchPreview.addedLines.map((addedLine) => addedLine.replace(/^\+/, ""));
  if (canRenderGitHubSuggestedChange(addedLines)) {
    return [
      "**Suggested change**",
      "```suggestion",
      ...addedLines,
      "```",
      "",
    ];
  }
  const codeFence = createCodeFence(addedLines, fencedLanguage);

  return [
    "**Suggested rewrite**",
    codeFence.open,
    ...addedLines,
    codeFence.close,
    "",
  ];
}

/**
 * Builds grouped-location context for same file/rule findings.
 *
 * @param groupedFindings - All findings grouped by file/rule key.
 * @returns Markdown lines describing additional grouped locations.
 */
export function buildAdditionalLocationsSection(groupedFindings: readonly Finding[]): readonly string[] {
  if (groupedFindings.length <= 1) {
    return [];
  }
  const count = groupedFindings.length - 1;
  const locations = groupedFindings
    .slice(1)
    .map((grouped) => `- \`${grouped.filePath}:${String(grouped.line)}\``);
  return [
    `<details><summary>Also affects ${count} other location${count === 1 ? "" : "s"}</summary>`,
    "",
    ...locations,
    "",
    "</details>",
    "",
  ];
}

/**
 * Returns whether lines are safe to render as a GitHub suggested-change block.
 *
 * @param lines - Suggested replacement lines.
 * @returns True when lines do not contain code-fence terminators.
 */
export function canRenderGitHubSuggestedChange(lines: readonly string[]): boolean {
  return lines.every((line) => !line.includes("```"));
}

/**
 * Builds Markdown code fence delimiters based on content backticks.
 *
 * @param lines - Code block content lines.
 * @param language - Optional fenced language identifier.
 * @returns Open/close fence pair.
 */
export function createCodeFence(
  lines: readonly string[],
  language: string,
): { readonly open: string; readonly close: string } {
  const longestBacktickRun = lines.reduce(
    (currentLongest, line) => Math.max(currentLongest, getLongestBacktickRun(line)),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return {
    open: `${fence}${language}`,
    close: fence,
  };
}

/**
 * Returns the longest run of consecutive backticks in text.
 *
 * @param text - Text to scan.
 * @returns Longest consecutive backtick run length.
 */
export function getLongestBacktickRun(text: string): number {
  const matches = text.match(/`+/g);
  if (!matches || matches.length === 0) {
    return 0;
  }
  return matches.reduce((currentLongest, matchValue) => {
    return Math.max(currentLongest, matchValue.length);
  }, 0);
}

/**
 * Builds a hidden metadata marker for dedupe and debugging.
 *
 * @param finding - Finding metadata source.
 * @param dedupeKey - Dedupe key assigned to the comment.
 * @returns Invisible metadata marker.
 */
export function buildDebugMetadataSection(finding: Finding, dedupeKey: string): string {
  return (
    `<!-- mergewise-meta dedupeKey=${dedupeKey} ` +
    `findingId=${finding.findingId} ruleId=${finding.ruleId} ` +
    `category=${finding.category} confidence=${finding.confidence.toFixed(2)} -->`
  );
}
