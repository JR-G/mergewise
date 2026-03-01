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
  readonly deliveryCounters?: DeliveryCounters;
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

export const INLINE_FINDING_LIMIT = 5;

export function truncateRecommendation(text: string, maxLength = 80): string {
  const escaped = escapeTableCell(text);
  if (escaped.length <= maxLength) return escaped;
  return escaped.slice(0, maxLength - 1) + "\u2026";
}

function buildFindingsTable(
  findings: readonly Finding[],
  repositoryFullName: string,
  headSha: string,
): string[] {
  const lines: string[] = [
    "| | File | Line | Suggestion |",
    "| --- | --- | --- | --- |",
  ];

  for (const finding of findings) {
    const emoji = CATEGORY_EMOJI[finding.category];
    const blobUrl = buildBlobUrl(repositoryFullName, headSha, finding.filePath, finding.line);
    const lineLink = `[${String(finding.line)}](${blobUrl})`;
    const truncated = truncateRecommendation(finding.recommendation);
    lines.push(`| ${emoji} | \`${finding.filePath}\` | ${lineLink} | ${truncated} |`);
  }

  return lines;
}

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

function buildReviewDetailsSection(
  rulesPassed: number,
  rulesRan: number,
  deliveryCounters: DeliveryCounters | undefined,
  filePaths: readonly string[],
): string[] {
  const lines: string[] = [
    "",
    "<details>",
    "<summary>\u2699\uFE0F Review details</summary>",
    "",
    `**Rules:** ${String(rulesPassed)}/${String(rulesRan)} passed`,
  ];

  if (deliveryCounters) {
    lines.push("");
    lines.push("**Delivery:**");
    lines.push(`- Skipped by confidence: ${String(deliveryCounters.skippedByConfidence)}`);
    lines.push(`- Skipped by deduplication: ${String(deliveryCounters.skippedByDeduplication)}`);
    lines.push(`- Skipped by policy: ${String(deliveryCounters.skippedByPolicy)}`);
    lines.push(`- Skipped by grouping: ${String(deliveryCounters.skippedByGrouping)}`);
    lines.push(`- Skipped by cap: ${String(deliveryCounters.skippedByCap)}`);
  }

  if (filePaths.length > 0) {
    lines.push("");
    const sortedPaths = [...filePaths].sort((left, right) => left.localeCompare(right));
    lines.push(`**Files reviewed:** ${sortedPaths.map((fp) => `\`${fp}\``).join(", ")}`);
  }

  lines.push("");
  lines.push("</details>");
  return lines;
}

function buildFindingsSection(
  findings: readonly Finding[],
  repositoryFullName: string,
  headSha: string,
): string[] {
  const sortedFindings = [...findings].sort((left, right) => {
    const severityDiff =
      CATEGORY_SEVERITY_ORDER.indexOf(left.category) -
      CATEGORY_SEVERITY_ORDER.indexOf(right.category);
    if (severityDiff !== 0) return severityDiff;
    const fileCompare = left.filePath.localeCompare(right.filePath);
    if (fileCompare !== 0) return fileCompare;
    return left.line - right.line;
  });

  const badges = buildCategoryBadges(findings);
  const lines: string[] = [
    "",
    "<details>",
    `<summary>\u{1F4CB} Suggestions | ${badges}</summary>`,
    "",
  ];

  const inlineFindings = sortedFindings.slice(0, INLINE_FINDING_LIMIT);
  const overflowFindings = sortedFindings.slice(INLINE_FINDING_LIMIT);

  lines.push(...buildFindingsTable(inlineFindings, repositoryFullName, headSha));

  if (overflowFindings.length > 0) {
    lines.push("");
    lines.push("<details>");
    lines.push(`<summary>and ${String(overflowFindings.length)} more</summary>`);
    lines.push("");
    lines.push(...buildFindingsTable(overflowFindings, repositoryFullName, headSha));
    lines.push("");
    lines.push("</details>");
  }

  lines.push("");
  lines.push("</details>");
  return lines;
}

/**
 * Builds the Markdown body for the PR summary comment.
 *
 * All sections are collapsed by default for a compact appearance similar
 * to CodeRabbit/Greptile. The header gives a one-line verdict; findings
 * and review details are expandable `<details>` blocks.
 */
export function buildPrSummaryComment(input: PrSummaryInput): string {
  const { filePaths, findings, repositoryFullName, headSha, rulesRan, rulesPassed, deliveryCounters } = input;
  const fileCount = filePaths.length;
  const lines: string[] = [PR_SUMMARY_COMMENT_MARKER];

  if (findings.length > 0) {
    const noun = findings.length === 1 ? "suggestion" : "suggestions";
    lines.push(
      `**Mergewise** \u00B7 Reviewed ${String(fileCount)} file${fileCount === 1 ? "" : "s"} \u2014 ${String(findings.length)} ${noun}`,
    );
    lines.push(...buildFindingsSection(findings, repositoryFullName, headSha));
  } else {
    lines.push(
      `**Mergewise** \u00B7 No issues found across ${String(fileCount)} file${fileCount === 1 ? "" : "s"} reviewed`,
    );
  }

  lines.push(...buildReviewDetailsSection(rulesPassed, rulesRan, deliveryCounters, filePaths));
  return lines.join("\n");
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
    readonly listPullRequestSummaryCommentsFn?: (
      opts: ListPullRequestCommentsOptions,
    ) => Promise<GitHubIssueComment[]>;
    readonly postPullRequestSummaryCommentFn?: (
      opts: PostPullRequestSummaryCommentOptions,
    ) => Promise<GitHubIssueComment>;
    readonly updateIssueCommentFn?: (
      opts: UpdateIssueCommentOptions,
    ) => Promise<GitHubIssueComment>;
    readonly logInfo?: (message: string) => void;
    readonly logError?: (message: string) => void;
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
