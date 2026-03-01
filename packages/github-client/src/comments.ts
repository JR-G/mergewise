import {
  type GitHubApiOptions,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Reaction counts returned by GitHub on comments.
 */
export interface GitHubReactionCounts {
  "+1": number;
  "-1": number;
  laugh: number;
  confused: number;
  heart: number;
  hooray: number;
  rocket: number;
  eyes: number;
}

/**
 * Response shape for created GitHub issue comments.
 */
export interface GitHubIssueComment {
  /**
   * Comment identifier.
   */
  id: number;
  /**
   * Global node identifier for GraphQL operations.
   */
  node_id: string;
  /**
   * HTML URL for the comment.
   */
  html_url: string;
  /**
   * Stored markdown body.
   */
  body: string;
  /**
   * Reaction counts on the comment, when returned by GitHub.
   */
  reactions?: GitHubReactionCounts;
}

/**
 * Response shape for created GitHub pull request review comments.
 */
export interface GitHubPullRequestReviewComment {
  /**
   * Review comment identifier.
   */
  id: number;
  /**
   * Global node identifier for GraphQL operations.
   */
  node_id: string;
  /**
   * HTML URL for the review comment.
   */
  html_url: string;
  /**
   * Stored markdown body.
   */
  body: string;
  /**
   * Repository path associated with this inline comment.
   */
  path?: string;
  /**
   * 1-based line number associated with this inline comment.
   */
  line?: number;
  /**
   * Reaction counts on the comment, when returned by GitHub.
   */
  reactions?: GitHubReactionCounts;
  /**
   * Diff position of the comment. Null when the comment is outdated
   * (the anchored code has changed since the comment was posted).
   */
  position?: number | null;
}

/**
 * Request options for posting a pull request summary comment.
 */
export interface PostPullRequestSummaryCommentOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Pull request number.
   */
  pullRequestNumber: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Markdown body for the summary comment.
   */
  body: string;
}

/**
 * Request options for posting an inline pull request review comment.
 */
export interface PostPullRequestInlineCommentOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Pull request number.
   */
  pullRequestNumber: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Pull request head commit SHA that the comment anchors to.
   */
  commitId: string;
  /**
   * Repository file path for the inline anchor.
   */
  path: string;
  /**
   * 1-based line number in the file for the inline anchor.
   */
  line: number;
  /**
   * Diff side for inline comments.
   *
   * @defaultValue `"RIGHT"`
   */
  side?: "LEFT" | "RIGHT";
  /**
   * Markdown body for the inline review comment.
   */
  body: string;
}

/**
 * Request options for listing pull request comments.
 */
export interface ListPullRequestCommentsOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Pull request number.
   */
  pullRequestNumber: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Page size used for pagination.
   *
   * @defaultValue `100`
   */
  perPage?: number;
  /**
   * Maximum number of pages to fetch.
   *
   * @defaultValue `20`
   */
  maxPages?: number;
}

/**
 * Request options for updating an existing issue comment.
 */
export interface UpdateIssueCommentOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Identifier of the issue comment to update.
   */
  commentId: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Updated Markdown body for the comment.
   */
  body: string;
}

/**
 * Posts a summary comment on a pull request conversation.
 *
 * @param options - Comment request options.
 * @returns Created issue comment payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function postPullRequestSummaryComment(
  options: PostPullRequestSummaryCommentOptions,
): Promise<GitHubIssueComment> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/issues/${options.pullRequestNumber}/comments`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify({ body: options.body }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return parseResponse<GitHubIssueComment>(response, "POST", endpointUrl);
}

/**
 * Posts an inline review comment on a pull request diff.
 *
 * @param options - Inline comment request options.
 * @returns Created pull request review comment payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function postPullRequestInlineComment(
  options: PostPullRequestInlineCommentOptions,
): Promise<GitHubPullRequestReviewComment> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/pulls/${options.pullRequestNumber}/comments`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify({
      body: options.body,
      commit_id: options.commitId,
      path: options.path,
      line: Math.max(1, Math.floor(options.line)),
      side: options.side ?? "RIGHT",
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return parseResponse<GitHubPullRequestReviewComment>(response, "POST", endpointUrl);
}

/**
 * Lists summary-level issue comments for a pull request.
 *
 * @param options - List request options.
 * @returns Pull request issue comments in API order.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function listPullRequestSummaryComments(
  options: ListPullRequestCommentsOptions,
): Promise<GitHubIssueComment[]> {
  const perPage = clamp(options.perPage ?? 100, 1, 100);
  const maxPages = clamp(options.maxPages ?? 20, 1, 50);
  const maxTotalComments = perPage * maxPages;
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const collectedComments: GitHubIssueComment[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const endpointUrl =
      `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
      `/${encodeURIComponent(options.repository)}` +
      `/issues/${options.pullRequestNumber}/comments` +
      `?per_page=${perPage}&page=${pageNumber}`;
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: buildHeaders({
        authorization: `Bearer ${options.installationAccessToken}`,
        userAgent: options.userAgent,
        traceId: options.traceId,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const pageComments = await parseResponse<GitHubIssueComment[]>(
      response,
      "GET",
      endpointUrl,
    );
    collectedComments.push(...pageComments);
    if (collectedComments.length >= maxTotalComments) {
      break;
    }
    if (pageComments.length < perPage) {
      break;
    }
  }

  return collectedComments;
}

/**
 * Lists inline review comments for a pull request.
 *
 * @param options - List request options.
 * @returns Pull request review comments in API order.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function listPullRequestInlineComments(
  options: ListPullRequestCommentsOptions,
): Promise<GitHubPullRequestReviewComment[]> {
  const perPage = clamp(options.perPage ?? 100, 1, 100);
  const maxPages = clamp(options.maxPages ?? 20, 1, 50);
  const maxTotalComments = perPage * maxPages;
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const collectedComments: GitHubPullRequestReviewComment[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const endpointUrl =
      `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
      `/${encodeURIComponent(options.repository)}` +
      `/pulls/${options.pullRequestNumber}/comments` +
      `?per_page=${perPage}&page=${pageNumber}`;
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: buildHeaders({
        authorization: `Bearer ${options.installationAccessToken}`,
        userAgent: options.userAgent,
        traceId: options.traceId,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const pageComments = await parseResponse<GitHubPullRequestReviewComment[]>(
      response,
      "GET",
      endpointUrl,
    );
    collectedComments.push(...pageComments);
    if (collectedComments.length >= maxTotalComments) {
      break;
    }
    if (pageComments.length < perPage) {
      break;
    }
  }

  return collectedComments;
}

/**
 * Updates an existing issue comment on a pull request conversation.
 *
 * @param options - Comment update options.
 * @returns Updated issue comment payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function updateIssueComment(
  options: UpdateIssueCommentOptions,
): Promise<GitHubIssueComment> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/issues/comments/${options.commentId}`;
  const response = await fetch(endpointUrl, {
    method: "PATCH",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify({ body: options.body }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return parseResponse<GitHubIssueComment>(response, "PATCH", endpointUrl);
}
