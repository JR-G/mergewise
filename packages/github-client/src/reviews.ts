import {
  type GitHubApiOptions,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

const MAX_REVIEW_COMMENTS = 50;
const MAX_COMMENT_BODY_LENGTH = 10_000;

/**
 * Inline comment included in a batch pull request review.
 */
export interface PullRequestReviewComment {
  /**
   * Repository file path for the inline anchor.
   */
  readonly path: string;
  /**
   * 1-based line number in the file for the inline anchor.
   */
  readonly line: number;
  /**
   * Diff side for inline comments.
   */
  readonly side?: "LEFT" | "RIGHT";
  /**
   * Markdown body for the inline review comment.
   */
  readonly body: string;
}

/**
 * Request options for creating a batch pull request review.
 */
export interface CreatePullRequestReviewOptions extends GitHubApiOptions {
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
   * Pull request head commit SHA that the review anchors to.
   */
  commitId: string;
  /**
   * Markdown body for the review-level comment.
   */
  body?: string;
  /**
   * Review event type.
   */
  event: "COMMENT";
  /**
   * Inline comments to include in the review.
   */
  comments: readonly PullRequestReviewComment[];
}

/**
 * Response shape for a created GitHub pull request review.
 */
export interface GitHubPullRequestReview {
  /**
   * Review identifier.
   */
  id: number;
  /**
   * HTML URL for the review.
   */
  html_url: string;
  /**
   * Review body text.
   */
  body: string | null;
  /**
   * Review state.
   */
  state: string;
}

/**
 * Creates a batch pull request review with inline comments.
 *
 * @param options - Review creation options.
 * @returns Created review payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function createPullRequestReview(
  options: CreatePullRequestReviewOptions,
): Promise<GitHubPullRequestReview> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/pulls/${options.pullRequestNumber}/reviews`;
  const requestBody: Record<string, unknown> = {
    commit_id: options.commitId,
    event: options.event,
    comments: options.comments
      .filter((comment) => Number.isInteger(comment.line) && comment.line >= 1)
      .slice(0, MAX_REVIEW_COMMENTS)
      .map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side ?? "RIGHT",
        body: comment.body.slice(0, MAX_COMMENT_BODY_LENGTH),
      })),
  };
  if (options.body !== undefined) {
    requestBody.body = options.body;
  }
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return parseResponse<GitHubPullRequestReview>(response, "POST", endpointUrl);
}
