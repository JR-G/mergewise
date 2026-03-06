import {
  listPullRequestSummaryComments,
  postPullRequestSummaryComment,
  updateIssueComment,
  type GitHubIssueComment,
  type ListPullRequestCommentsOptions,
  type PostPullRequestSummaryCommentOptions,
  type UpdateIssueCommentOptions,
} from "@mergewise/github-client";
import type {
  Finding,
  FindingCategory,
} from "@mergewise/shared-types";
import type { WorkerGitHubFetchOptions } from "./config";
import { wrapCodeIdentifiers } from "./comment-formatter";

export const PR_SUMMARY_COMMENT_MARKER = "<!-- mergewise-summary -->";

/**
 * Delivery skip counters for inclusion in the collapsed review details section.
 */
export interface DeliveryCounters {
  readonly skippedByConfidence: number;
  readonly skippedByDeduplication: number;
  readonly skippedByPolicy: number;
  readonly skippedByGrouping: number;
  readonly skippedByCap: number;
  readonly skippedBySimilarity: number;
}

/**
 * Input for {@link buildPrSummaryComment}.
 */
export interface PrSummaryInput {
  /** Relative paths of all files included in the review. */
  readonly filePaths: readonly string[];
  /** Gated findings produced by the analysis pipeline. */
  readonly findings: readonly Finding[];
  /** Repository in `owner/name` format for blob links. */
  readonly repositoryFullName: string;
  /** PR head commit SHA used to construct permalink URLs. */
  readonly headSha: string;
  /** Total number of rules that were executed. */
  readonly rulesRan: number;
  /** Number of rules that completed without errors. */
  readonly rulesPassed: number;
  /** Delivery skip counters for the collapsed review details section. */
  readonly deliveryCounters?: DeliveryCounters | undefined;
}

export const CATEGORY_EMOJI: Readonly<Record<FindingCategory, string>> = {
  safety: "\u{1F534}",
  perf: "\u{1F7E1}",
  clean: "\u{1F535}",
  idiomatic: "\u{1F7E2}",
};

export const CATEGORY_SEVERITY_ORDER: readonly FindingCategory[] = [
  "safety",
  "perf",
  "clean",
  "idiomatic",
];

/**
 * Comparator that orders findings by severity (safety first), then file path,
 * then line number.
 */
export function compareFindings(left: Finding, right: Finding): number {
  const severityDiff =
    CATEGORY_SEVERITY_ORDER.indexOf(left.category) -
    CATEGORY_SEVERITY_ORDER.indexOf(right.category);
  if (severityDiff !== 0) return severityDiff;
  const fileCompare = left.filePath.localeCompare(right.filePath);
  if (fileCompare !== 0) return fileCompare;
  return left.line - right.line;
}

export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function buildBlobUrl(
  repositoryFullName: string,
  headSha: string,
  filePath: string,
  line: number,
): string {
  const encodedFilePath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const normalizedLine = Math.max(1, line);
  return (
    `https://github.com/${repositoryFullName}` +
    `/blob/${encodeURIComponent(headSha)}/${encodedFilePath}#L${String(normalizedLine)}`
  );
}

export function buildLocationLink(
  repositoryFullName: string,
  headSha: string,
  filePath: string,
  line: number,
): string {
  const blobUrl = buildBlobUrl(repositoryFullName, headSha, filePath, line);
  return `[\`${filePath}:${String(line)}\`](${blobUrl})`;
}

/** Maximum files shown per suggestion in the locations table. */
export const INLINE_FINDING_LIMIT = 5;

/** Maximum file paths listed inline before the remainder are summarised as a count. */
export const MAX_FILES_DISPLAY = 50;

/** Maximum character length for the PR summary comment body. */
export const PR_SUMMARY_CHAR_LIMIT = 4000;

/**
 * Escapes table-cell characters then truncates to {@link maxLength},
 * appending an ellipsis when the escaped text exceeds the limit.
 */
export function truncateRecommendation(text: string, maxLength = 80): string {
  const escaped = escapeTableCell(text);
  if (escaped.length <= maxLength) return escaped;
  return escaped.slice(0, maxLength - 1) + "\u2026";
}

/**
 * Returns a severity-ordered badge string (e.g. `🔴 2 · 🟡 1`) for the
 * given findings, omitting categories with zero occurrences.
 */
export function buildCategoryBadges(findings: readonly Finding[]): string {
  const counts = new Map<FindingCategory, number>();
  for (const finding of findings) {
    counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  }

  return CATEGORY_SEVERITY_ORDER
    .filter((category) => (counts.get(category) ?? 0) > 0)
    .map((category) => `${CATEGORY_EMOJI[category]} ${String(counts.get(category))}`)
    .join(" \u00B7 ");
}

/**
 * A themed group of findings sharing a rule and recommendation.
 */
interface SuggestionGroup {
  readonly category: FindingCategory;
  readonly recommendation: string;
  readonly findings: readonly Finding[];
}

/**
 * Groups findings by ruleId and unique recommendation text.
 *
 * Static rules produce identical recommendations per rule, yielding one group.
 * LLM rules produce unique recommendations per finding, yielding separate groups.
 */
export function groupFindingsIntoSuggestions(findings: readonly Finding[]): readonly SuggestionGroup[] {
  const groupMap = new Map<string, { category: FindingCategory; recommendation: string; findings: Finding[] }>();

  for (const finding of findings) {
    const groupKey = `${finding.ruleId}\0${finding.recommendation}`;
    const existing = groupMap.get(groupKey);
    if (existing) {
      existing.findings.push(finding);
    } else {
      groupMap.set(groupKey, {
        category: finding.category,
        recommendation: finding.recommendation,
        findings: [finding],
      });
    }
  }

  const groups = [...groupMap.values()];
  groups.sort((left, right) => {
    const severityDiff =
      CATEGORY_SEVERITY_ORDER.indexOf(left.category) -
      CATEGORY_SEVERITY_ORDER.indexOf(right.category);
    if (severityDiff !== 0) return severityDiff;
    return right.findings.length - left.findings.length;
  });

  return groups;
}

/**
 * Extracts the first sentence from a recommendation for use as a suggestion title.
 *
 * Splits on `. ` (period followed by space) and returns the first segment.
 * Falls back to the full text if no sentence boundary is found.
 */
export function extractSuggestionTitle(recommendation: string): string {
  const periodIndex = recommendation.indexOf(". ");
  if (periodIndex === -1) {
    return recommendation.endsWith(".") ? recommendation.slice(0, -1) : recommendation;
  }
  return recommendation.slice(0, periodIndex);
}

/**
 * Extracts the body text after the first sentence of a recommendation.
 *
 * Returns an empty string when the recommendation is a single sentence.
 */
export function extractSuggestionBody(recommendation: string): string {
  const periodIndex = recommendation.indexOf(". ");
  if (periodIndex === -1) return "";
  return recommendation.slice(periodIndex + 2);
}

/**
 * Builds a blockquote from recommendation text, applying code identifier wrapping.
 */
function buildRecommendationBlockquote(recommendation: string): string[] {
  const wrapped = wrapCodeIdentifiers(escapeTableCell(recommendation));
  const sentences = wrapped.split(". ");
  return sentences.map((sentence, index) => {
    const suffix = index < sentences.length - 1 ? "." : "";
    return `> ${sentence}${suffix}`;
  });
}

/**
 * Builds the locations table for a suggestion group, grouping by file.
 */
function buildLocationsSection(
  findings: readonly Finding[],
  repositoryFullName: string,
  headSha: string,
): string[] {
  const fileGroups = new Map<string, Finding[]>();
  for (const finding of [...findings].sort(compareFindings)) {
    const existing = fileGroups.get(finding.filePath);
    if (existing) {
      existing.push(finding);
    } else {
      fileGroups.set(finding.filePath, [finding]);
    }
  }

  const fileEntries = [...fileGroups.entries()];
  const totalFiles = fileEntries.length;
  const totalLocations = findings.length;

  const singleFinding = totalLocations === 1 ? findings[0] : undefined;
  if (singleFinding !== undefined) {
    const blobUrl = buildBlobUrl(repositoryFullName, headSha, singleFinding.filePath, singleFinding.line);
    return [`\`${singleFinding.filePath}\` \u00B7 [${String(singleFinding.line)}](${blobUrl})`];
  }

  const displayEntries = fileEntries.slice(0, INLINE_FINDING_LIMIT);
  const lines: string[] = [
    "| File | Lines |",
    "| --- | --- |",
  ];

  let displayedLocationCount = 0;
  for (const [filePath, fileFindings] of displayEntries) {
    const lineLinks = fileFindings.map((finding) => {
      const blobUrl = buildBlobUrl(repositoryFullName, headSha, finding.filePath, finding.line);
      return `[${String(finding.line)}](${blobUrl})`;
    });
    lines.push(`| \`${filePath}\` | ${lineLinks.join(", ")} |`);
    displayedLocationCount += fileFindings.length;
  }

  const remainingFiles = totalFiles - displayEntries.length;
  const remainingLocations = totalLocations - displayedLocationCount;
  if (remainingLocations > 0) {
    lines.push("");
    const fileSuffix = remainingFiles === 1 ? "file" : "files";
    lines.push(`<sub>and ${String(remainingLocations)} more location${remainingLocations === 1 ? "" : "s"} across ${String(remainingFiles)} ${fileSuffix}</sub>`);
  }

  return lines;
}

/**
 * Builds a single suggestion `<details>` block.
 */
function buildSuggestionBlock(
  group: SuggestionGroup,
  repositoryFullName: string,
  headSha: string,
): string[] {
  const emoji = CATEGORY_EMOJI[group.category];
  const title = escapeTableCell(extractSuggestionTitle(group.recommendation));
  const locationCount = group.findings.length;
  const locationNoun = locationCount === 1 ? "location" : "locations";

  const lines: string[] = [
    "",
    "<details>",
    `<summary>${emoji} <strong>${title}</strong> \u00B7 ${String(locationCount)} ${locationNoun}</summary>`,
    "<br>",
    "",
  ];

  lines.push(...buildRecommendationBlockquote(group.recommendation));
  lines.push("");
  lines.push(...buildLocationsSection(group.findings, repositoryFullName, headSha));
  lines.push("");
  lines.push("</details>");

  return lines;
}

/**
 * Builds the full findings section as themed suggestion blocks.
 */
function buildFindingsSection(
  findings: readonly Finding[],
  repositoryFullName: string,
  headSha: string,
): string[] {
  const groups = groupFindingsIntoSuggestions(findings);
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(...buildSuggestionBlock(group, repositoryFullName, headSha));
  }
  return lines;
}

/**
 * Builds a truncated findings section that fits within a character budget.
 *
 * Includes as many full suggestion blocks as the budget allows,
 * then appends an overflow note for the remainder.
 */
function buildTruncatedFindingsSection(
  findings: readonly Finding[],
  repositoryFullName: string,
  headSha: string,
  charBudget: number,
): string[] {
  const groups = groupFindingsIntoSuggestions(findings);
  const overflowLine = "\n\n<sub>and __COUNT__ more suggestion(s)</sub>";
  const overflowOverhead = overflowLine.length + 10;

  const lines: string[] = [];
  let usedChars = 0;
  let includedCount = 0;

  for (const group of groups) {
    const blockLines = buildSuggestionBlock(group, repositoryFullName, headSha);
    const blockLength = blockLines.join("\n").length;

    if (usedChars + blockLength + overflowOverhead > charBudget && includedCount > 0) {
      break;
    }

    lines.push(...blockLines);
    usedChars += blockLength;
    includedCount += 1;
  }

  const remainingCount = groups.length - includedCount;
  if (remainingCount > 0) {
    lines.push("");
    lines.push(`<sub>and ${String(remainingCount)} more suggestion${remainingCount === 1 ? "" : "s"}</sub>`);
  }

  return lines;
}

function buildReviewDetailsSection(
  rulesPassed: number,
  rulesRan: number,
  filePaths: readonly string[],
): string[] {
  const lines: string[] = [
    "",
    "<details>",
    "<summary>\u2699\uFE0F Review details</summary>",
    "<br>",
    "",
    `**Rules:** ${String(rulesPassed)}/${String(rulesRan)} passed`,
  ];

  if (filePaths.length > 0) {
    lines.push("");
    const sortedPaths = [...filePaths].sort((left, right) => left.localeCompare(right));
    const displayedPaths = sortedPaths.slice(0, MAX_FILES_DISPLAY);
    const remaining = sortedPaths.length - displayedPaths.length;
    const fileList = displayedPaths.map((filePath) => `\`${filePath}\``).join(", ");
    const suffix = remaining > 0 ? ` and ${String(remaining)} more` : "";
    lines.push(`**Files reviewed:** ${fileList}${suffix}`);
  }

  lines.push("");
  lines.push("</details>");
  return lines;
}

/**
 * Builds the Markdown body for the PR summary comment.
 *
 * Findings are grouped by rule and recommendation into themed suggestion
 * blocks. Each block is a collapsible `<details>` element with a blockquote
 * explanation and a locations table. Review details are a separate collapsed
 * section at the bottom.
 */
export function buildPrSummaryComment(input: PrSummaryInput): string {
  const { filePaths, findings, repositoryFullName, headSha, rulesRan, rulesPassed } = input;
  const fileCount = filePaths.length;
  const headerLines: string[] = [PR_SUMMARY_COMMENT_MARKER];

  if (findings.length > 0) {
    const groups = groupFindingsIntoSuggestions(findings);
    const groupCount = groups.length;
    const noun = groupCount === 1 ? "suggestion" : "suggestions";
    headerLines.push(
      `**Mergewise** \u00B7 Reviewed ${String(fileCount)} file${fileCount === 1 ? "" : "s"} \u2014 ${String(groupCount)} ${noun}`,
    );
  } else {
    headerLines.push(
      `**Mergewise** \u00B7 No issues found across ${String(fileCount)} file${fileCount === 1 ? "" : "s"} reviewed`,
    );
  }

  const reviewDetailsLines = buildReviewDetailsSection(rulesPassed, rulesRan, filePaths);
  const baseContent = [...headerLines, ...reviewDetailsLines].join("\n");

  if (findings.length === 0) {
    return baseContent.slice(0, PR_SUMMARY_CHAR_LIMIT);
  }

  const findingsLines = buildFindingsSection(findings, repositoryFullName, headSha);
  const fullComment = [...headerLines, ...findingsLines, ...reviewDetailsLines].join("\n");

  if (fullComment.length <= PR_SUMMARY_CHAR_LIMIT) {
    return fullComment;
  }

  const findingsBudget = PR_SUMMARY_CHAR_LIMIT - baseContent.length;
  if (findingsBudget <= 0) {
    return baseContent.slice(0, PR_SUMMARY_CHAR_LIMIT);
  }

  const truncatedFindingsLines = buildTruncatedFindingsSection(
    findings,
    repositoryFullName,
    headSha,
    findingsBudget,
  );

  const truncatedComment = [...headerLines, ...truncatedFindingsLines, ...reviewDetailsLines].join("\n");
  if (truncatedComment.length > PR_SUMMARY_CHAR_LIMIT) {
    return baseContent.slice(0, PR_SUMMARY_CHAR_LIMIT);
  }
  return truncatedComment;
}

/**
 * Upserts the PR summary comment by finding an existing comment with the
 * hidden marker or creating a new one.
 *
 * @param options - Repository coordinates, token, and comment body.
 * @param dependencies - API function overrides for testing.
 * @returns The created or updated comment.
 */
export async function upsertPrSummaryComment(
  options: {
    readonly owner: string;
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly installationAccessToken: string;
    readonly body: string;
    readonly traceId: string;
    readonly githubFetchOptions: WorkerGitHubFetchOptions;
  },
  dependencies: {
    readonly listPullRequestSummaryCommentsFn?: ((
      opts: ListPullRequestCommentsOptions,
    ) => Promise<GitHubIssueComment[]>) | undefined;
    readonly postPullRequestSummaryCommentFn?: ((
      opts: PostPullRequestSummaryCommentOptions,
    ) => Promise<GitHubIssueComment>) | undefined;
    readonly updateIssueCommentFn?: ((
      opts: UpdateIssueCommentOptions,
    ) => Promise<GitHubIssueComment>) | undefined;
    readonly logInfo?: ((message: string) => void) | undefined;
    readonly logError?: ((message: string) => void) | undefined;
  } = {},
): Promise<GitHubIssueComment> {
  const listFn = dependencies.listPullRequestSummaryCommentsFn ?? listPullRequestSummaryComments;
  const postFn = dependencies.postPullRequestSummaryCommentFn ?? postPullRequestSummaryComment;
  const updateFn = dependencies.updateIssueCommentFn ?? updateIssueComment;
  const infoLogger = dependencies.logInfo ?? console.log;

  const existingComments = await listFn({
    owner: options.owner,
    repository: options.repository,
    pullRequestNumber: options.pullRequestNumber,
    installationAccessToken: options.installationAccessToken,
    apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
    userAgent: options.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    traceId: options.traceId,
  });

  const existingSummaryComment = existingComments.find(
    (comment) => comment.body.includes(PR_SUMMARY_COMMENT_MARKER),
  );

  if (existingSummaryComment) {
    infoLogger(
      `[worker] updating_summary_comment trace=${options.traceId} commentId=${existingSummaryComment.id}`,
    );
    return updateFn({
      owner: options.owner,
      repository: options.repository,
      commentId: existingSummaryComment.id,
      installationAccessToken: options.installationAccessToken,
      body: options.body,
      apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
      userAgent: options.githubFetchOptions.githubUserAgent,
      requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
      traceId: options.traceId,
    });
  }

  infoLogger(
    `[worker] creating_summary_comment trace=${options.traceId}`,
  );
  return postFn({
    owner: options.owner,
    repository: options.repository,
    pullRequestNumber: options.pullRequestNumber,
    installationAccessToken: options.installationAccessToken,
    body: options.body,
    apiBaseUrl: options.githubFetchOptions.githubApiBaseUrl,
    userAgent: options.githubFetchOptions.githubUserAgent,
    requestTimeoutMs: options.githubFetchOptions.githubRequestTimeoutMs,
    traceId: options.traceId,
  });
}
