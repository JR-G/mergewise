import {
  type GitHubApiOptions,
  GitHubApiError,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

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
  patch?: string | undefined;
  /**
   * Blob URL for the file at the head commit.
   */
  blob_url?: string | undefined;
  /**
   * Raw URL for retrieving file content.
   */
  raw_url?: string | undefined;
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
  perPage?: number | undefined;
  /**
   * Maximum number of pages to fetch.
   *
   * @defaultValue `20`
   */
  maxPages?: number | undefined;
}

/**
 * Request options for fetching a single pull request.
 */
export interface FetchPullRequestOptions extends GitHubApiOptions {
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
}

/**
 * Pull request state returned by GitHub REST API.
 */
export interface GitHubPullRequest {
  /**
   * Pull request number.
   */
  readonly number: number;
  /**
   * Pull request state.
   */
  readonly state: "open" | "closed";
  /**
   * Whether the pull request has been merged.
   */
  readonly merged: boolean;
  /**
   * Pull request title.
   */
  readonly title: string;
}

/**
 * Request options for fetching a single file's content from a repository.
 */
export interface FetchFileContentOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * File path relative to repository root.
   */
  path: string;
  /**
   * Git ref (branch, tag, or SHA) to read the file at.
   */
  ref: string;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
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
  const rawPerPage = options.perPage ?? 100;
  const rawMaxPages = options.maxPages ?? 20;

  if (!Number.isFinite(rawPerPage)) {
    throw new Error(`perPage must be a finite number, got: ${rawPerPage}`);
  }
  if (!Number.isFinite(rawMaxPages)) {
    throw new Error(`maxPages must be a finite number, got: ${rawMaxPages}`);
  }

  const perPage = Math.max(1, Math.min(Math.floor(rawPerPage), 100));
  const maxPages = Math.max(1, Math.min(Math.floor(rawMaxPages), 50));
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
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
        traceId: options.traceId,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
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
 * Fetches a single pull request from the GitHub REST API.
 *
 * @param options - Pull request fetch options.
 * @returns Parsed pull request state.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function fetchPullRequest(
  options: FetchPullRequestOptions,
): Promise<GitHubPullRequest> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/pulls/${options.pullRequestNumber}`;
  const response = await fetch(endpointUrl, {
    method: "GET",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      traceId: options.traceId,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await parseResponse<{
    number: number;
    state: "open" | "closed";
    merged: boolean;
    title: string;
  }>(response, "GET", endpointUrl);
  return {
    number: body.number,
    state: body.state,
    merged: body.merged,
    title: body.title,
  };
}

/**
 * Fetches a single file's content from a repository via the GitHub Contents API.
 *
 * @param options - File content request options.
 * @returns Decoded file content as a string, or `null` if the file does not exist (404).
 * @throws {@link GitHubApiError} when GitHub returns a non-success status other than 404.
 */
export async function fetchFileContent(
  options: FetchFileContentOptions,
): Promise<string | null> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/contents/${options.path.split("/").map(encodeURIComponent).join("/")}` +
    `?ref=${encodeURIComponent(options.ref)}`;

  const response = await fetch(endpointUrl, {
    method: "GET",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      traceId: options.traceId,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new GitHubApiError(response.status, "GET", endpointUrl, responseBody);
  }

  const body = (await response.json()) as { content?: string; encoding?: string };

  if (body.encoding !== "base64" || typeof body.content !== "string") {
    return null;
  }

  return Buffer.from(body.content, "base64").toString("utf8");
}
