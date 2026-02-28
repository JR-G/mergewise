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
  /**
   * Request timeout in milliseconds for GitHub API calls.
   *
   * @defaultValue `10000`
   */
  requestTimeoutMs?: number;
  /**
   * Optional trace identifier propagated across API calls for log stitching.
   */
  traceId?: string;
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
 * Error representing a failed GitHub GraphQL request.
 */
export class GitHubGraphQlError extends Error {
  /**
   * GraphQL error entries returned by the API.
   */
  public readonly errors: readonly Record<string, unknown>[];

  public constructor(
    errors: readonly Record<string, unknown>[],
    requestUrl: string,
  ) {
    const firstMessage =
      (errors[0]?.message as string | undefined) ?? "Unknown GraphQL error";
    super(`GitHub GraphQL request failed: ${requestUrl} — ${firstMessage}`);
    this.name = "GitHubGraphQlError";
    this.errors = errors;
  }
}

export interface HeaderBuildOptions {
  authorization: string;
  userAgent?: string;
  contentType?: string;
  traceId?: string;
}

export function buildHeaders(options: HeaderBuildOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: options.authorization,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": options.userAgent ?? "mergewise-github-client",
  };

  if (options.contentType) {
    headers["Content-Type"] = options.contentType;
  }
  if (options.traceId) {
    headers["X-Mergewise-Trace-Id"] = options.traceId;
  }

  return headers;
}

export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 10_000;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid requestTimeoutMs value: ${String(value)}`);
  }

  return Math.floor(value);
}

export async function parseResponse<ResponseValue>(
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

export async function parseGraphQlResponse<T>(
  response: Response,
  requestUrl: string,
  extractData: (data: unknown) => T,
): Promise<T> {
  if (!response.ok) {
    const responseBody = await response.text();
    throw new GitHubApiError(
      response.status,
      "POST",
      requestUrl,
      responseBody,
    );
  }

  const body = (await response.json()) as {
    data?: unknown;
    errors?: Record<string, unknown>[];
  };

  if (body.errors && body.errors.length > 0) {
    throw new GitHubGraphQlError(body.errors, requestUrl);
  }

  return extractData(body.data);
}
