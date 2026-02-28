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
}

export const CATEGORY_EMOJI: Readonly<Record<FindingCategory, string>> = {
  safety: "🔴",
  perf: "🟡",
  clean: "🔵",
  idiomatic: "🟢",
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

export interface FindingGroup {
  readonly category: FindingCategory;
  readonly recommendation: string;
  readonly locations: readonly { readonly filePath: string; readonly line: number }[];
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

export const INLINE_LOCATION_THRESHOLD = 4;

export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
  const groupMap = new Map<string, FindingGroup & { locations: { filePath: string; line: number }[] }>();

  for (const finding of findings) {
    const key = `${finding.ruleId}\0${finding.recommendation}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.locations.push({ filePath: finding.filePath, line: finding.line });
    } else {
      groupMap.set(key, {
        category: finding.category,
        recommendation: finding.recommendation,
        locations: [{ filePath: finding.filePath, line: finding.line }],
      });
    }
  }

  const groups = [...groupMap.values()];

  for (const group of groups) {
    group.locations.sort((left, right) => {
      const fileCompare = left.filePath.localeCompare(right.filePath);
      if (fileCompare !== 0) return fileCompare;
      return left.line - right.line;
    });
  }

  groups.sort((left, right) => {
    const severityDiff =
      CATEGORY_SEVERITY_ORDER.indexOf(left.category) -
      CATEGORY_SEVERITY_ORDER.indexOf(right.category);
    if (severityDiff !== 0) return severityDiff;
    const leftFile = left.locations[0]?.filePath ?? "";
    const rightFile = right.locations[0]?.filePath ?? "";
    return leftFile.localeCompare(rightFile);
  });

  return groups;
}

export function buildCollapsibleDetail(
  group: FindingGroup,
  repositoryFullName: string,
  headSha: string,
): string[] {
  const emoji = CATEGORY_EMOJI[group.category];
  const uniqueFiles = [...new Set(group.locations.map((loc) => loc.filePath))].sort();
  const truncatedRecommendation =
    group.recommendation.length > 60
      ? group.recommendation.slice(0, 57) + "..."
      : group.recommendation;

  const lines: string[] = [
    "<details>",
    `<summary>${emoji} ${String(group.locations.length)} × ${escapeTableCell(truncatedRecommendation)} (${String(uniqueFiles.length)} file${uniqueFiles.length === 1 ? "" : "s"})</summary>`,
    "",
  ];

  for (const file of uniqueFiles) {
    const fileLines = group.locations
      .filter((loc) => loc.filePath === file)
      .map((loc) => {
        const blobUrl = buildBlobUrl(repositoryFullName, headSha, file, loc.line);
        return `[${String(loc.line)}](${blobUrl})`;
      });
    lines.push(`- \`${file}\` — lines ${fileLines.join(", ")}`);
  }

  lines.push("", "</details>");
  return lines;
}

/**
 * Builds the Markdown body for the PR summary comment.
 *
 * Findings with the same rule and recommendation are grouped into a single
 * table row. Groups with four or more locations render a collapsible detail
 * section listing every affected file and line.
 */
export function buildPrSummaryComment(input: PrSummaryInput): string {
  const { filePaths, findings, repositoryFullName, headSha, rulesRan, rulesPassed } = input;
  const fileCount = filePaths.length;
  const lines: string[] = [PR_SUMMARY_COMMENT_MARKER, "## Mergewise Review Summary", ""];

  const fileStat = `**${fileCount}** file${fileCount === 1 ? "" : "s"} reviewed`;
  const ruleStat = `**${rulesPassed}/${rulesRan}** rules passed`;

  if (findings.length > 0) {
    const findingStat =
      `**${findings.length}** finding${findings.length === 1 ? "" : "s"}`;
    lines.push(`${fileStat} · ${findingStat} · ${ruleStat}`, "");
  } else {
    lines.push(`${fileStat} · ✅ No issues found · ${ruleStat}`, "");
  }

  if (findings.length > 0) {
    const groups = groupFindings(findings);
    const collapsibleSections: string[][] = [];

    lines.push("| Severity | Recommendation | Locations |", "| --- | --- | --- |");
    for (const group of groups) {
      const emoji = CATEGORY_EMOJI[group.category];
      const safeRecommendation = escapeTableCell(group.recommendation);
      let locationCell: string;

      if (group.locations.length < INLINE_LOCATION_THRESHOLD) {
        locationCell = group.locations
          .map((loc) => buildLocationLink(repositoryFullName, headSha, loc.filePath, loc.line))
          .join(", ");
      } else {
        const uniqueFiles = new Set(group.locations.map((loc) => loc.filePath));
        locationCell =
          `${String(group.locations.length)} locations across ` +
          `${String(uniqueFiles.size)} file${uniqueFiles.size === 1 ? "" : "s"}`;
        collapsibleSections.push(
          buildCollapsibleDetail(group, repositoryFullName, headSha),
        );
      }

      lines.push(
        `| ${emoji} ${group.category} | ${safeRecommendation} | ${locationCell} |`,
      );
    }
    lines.push("");

    for (const section of collapsibleSections) {
      lines.push(...section, "");
    }
  }

  if (fileCount > 0) {
    lines.push(
      "<details>",
      `<summary>Files reviewed (${fileCount})</summary>`,
      "",
    );
    const sortedPaths = [...filePaths].sort((left, right) => left.localeCompare(right));
    for (const filePath of sortedPaths) {
      lines.push(`- \`${filePath}\``);
    }
    lines.push("", "</details>");
  }

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
