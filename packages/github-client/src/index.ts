import { createSign } from "node:crypto";

/**
 * Runtime options for GitHub App JWT creation.
 */
export interface GitHubAppJwtOptions {
  /**
   * GitHub App identifier.
   */
  appId: number;
  /**
   * PEM-encoded RSA private key for signing the JWT.
   */
  privateKeyPem: string;
  /**
   * Optional current time override in seconds for deterministic testing.
   */
  nowSeconds?: number;
}

/**
 * API configuration for the GitHub REST client.
 */
export interface GitHubApiOptions {
  /**
   * Base URL for GitHub API requests.
   *
   * @defaultValue `"https://api.github.com"`
   */
  apiBaseUrl?: string;
  /**
   * Value for the User-Agent header.
   *
   * @defaultValue `"mergewise-github-client"`
   */
  userAgent?: string;
}

/**
 * Response payload returned by GitHub installation token exchange.
 */
export interface GitHubInstallationAccessToken {
  /**
   * Installation access token value.
   */
  token: string;
  /**
   * ISO timestamp for token expiration.
   */
  expires_at: string;
}

/**
 * Pull request file entry returned by GitHub REST API.
 */
export interface GitHubPullRequestFile {
  /**
   * File path in the repository.
   */
  filename: string;
  /**
   * File-level status (`added`, `modified`, `removed`, etc.).
   */
  status: string;
  /**
   * Number of added lines.
   */
  additions: number;
  /**
   * Number of deleted lines.
   */
  deletions: number;
  /**
   * Total changed lines.
   */
  changes: number;
  /**
   * Optional patch snippet supplied by GitHub.
   */
  patch?: string;
  /**
   * Blob URL for the file at the head commit.
   */
  blob_url?: string;
  /**
   * Raw URL for retrieving file content.
   */
  raw_url?: string;
}

/**
 * Request options for fetching pull request files.
 */
export interface FetchPullRequestFilesOptions extends GitHubApiOptions {
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
 * Response shape for created GitHub issue comments.
 */
export interface GitHubIssueComment {
  /**
   * Comment identifier.
   */
  id: number;
  /**
   * HTML URL for the comment.
   */
  html_url: string;
  /**
   * Stored markdown body.
   */
  body: string;
}

/**
 * Error representing a failed GitHub API request.
 */
export class GitHubApiError extends Error {
  /**
   * HTTP status code returned by GitHub.
   */
  public readonly status: number;
  /**
   * HTTP method used for the failed request.
   */
  public readonly method: string;
  /**
   * Request URL for the failed request.
   */
  public readonly url: string;
  /**
   * Raw response body text for diagnostics.
   */
  public readonly responseBody: string;

  /**
   * Creates a typed GitHub API error.
   *
   * @param status - HTTP status code.
   * @param method - Request method.
   * @param url - Request URL.
   * @param responseBody - Raw response body.
   */
  public constructor(
    status: number,
    method: string,
    url: string,
    responseBody: string,
  ) {
    super(`GitHub API request failed: ${method} ${url} (${status})`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.url = url;
    this.responseBody = responseBody;
  }
}

/**
 * Creates a GitHub App JWT signed with RS256.
 *
 * @param options - JWT creation options.
 * @returns Signed compact JWT string.
 */
export function createGitHubAppJwt(options: GitHubAppJwtOptions): string {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const issuedAt = nowSeconds - 60;
  const expiresAt = nowSeconds + 600;

  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: String(options.appId),
  };

  const encodedHeader = toBase64Url(JSON.stringify(jwtHeader));
  const encodedPayload = toBase64Url(JSON.stringify(jwtPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(options.privateKeyPem, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Exchanges an app JWT for an installation access token.
 *
 * @param appJwt - GitHub App JWT.
 * @param installationId - Installation identifier.
 * @param options - Optional API configuration.
 * @returns Installation access token payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function exchangeInstallationAccessToken(
  appJwt: string,
  installationId: number,
  options: GitHubApiOptions = {},
): Promise<GitHubInstallationAccessToken> {
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const endpointUrl = `${trimTrailingSlash(apiBaseUrl)}/app/installations/${installationId}/access_tokens`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${appJwt}`,
      userAgent: options.userAgent,
    }),
  });

  const parsedResponse = await parseResponse<GitHubInstallationAccessToken>(
    response,
    "POST",
    endpointUrl,
  );
  return parsedResponse;
}

/**
 * Fetches changed files for a pull request with bounded pagination.
 *
 * @param options - Pull request files request options.
 * @returns Pull request files in API order.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function fetchPullRequestFiles(
  options: FetchPullRequestFilesOptions,
): Promise<GitHubPullRequestFile[]> {
  const perPage = options.perPage ?? 100;
  const maxPages = options.maxPages ?? 20;
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const collectedFiles: GitHubPullRequestFile[] = [];

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const endpointUrl =
      `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
      `/${encodeURIComponent(options.repository)}` +
      `/pulls/${options.pullRequestNumber}/files` +
      `?per_page=${perPage}&page=${pageNumber}`;
    const response = await fetch(endpointUrl, {
      method: "GET",
      headers: buildHeaders({
        authorization: `Bearer ${options.installationAccessToken}`,
        userAgent: options.userAgent,
      }),
    });
    const pageFiles = await parseResponse<GitHubPullRequestFile[]>(
      response,
      "GET",
      endpointUrl,
    );

    collectedFiles.push(...pageFiles);

    if (pageFiles.length < perPage) {
      break;
    }
  }

  return collectedFiles;
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
    }),
    body: JSON.stringify({ body: options.body }),
  });
  const createdComment = await parseResponse<GitHubIssueComment>(
    response,
    "POST",
    endpointUrl,
  );
  return createdComment;
}

type HeaderBuildOptions = {
  authorization: string;
  userAgent?: string;
  contentType?: string;
};

function buildHeaders(options: HeaderBuildOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: options.authorization,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": options.userAgent ?? "mergewise-github-client",
  };

  if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  }

  return headers;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function parseResponse<ResponseValue>(
  response: Response,
  method: string,
  requestUrl: string,
): Promise<ResponseValue> {
  if (!response.ok) {
    const responseBody = await response.text();
    throw new GitHubApiError(response.status, method, requestUrl, responseBody);
  }

  return (await response.json()) as ResponseValue;
}
