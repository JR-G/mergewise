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

/**
 * Options for constructing GitHub API request headers.
 */
export interface HeaderBuildOptions {
  /** Bearer token for the Authorization header. */
  authorization: string;
  /** Value for the User-Agent header. Defaults to `"mergewise-github-client"`. */
  userAgent?: string;
  /** MIME type for the Content-Type header when present. */
  contentType?: string;
  /** Optional trace identifier propagated as `X-Mergewise-Trace-Id`. */
  traceId?: string;
}

/**
 * Constructs standard GitHub API request headers.
 *
 * @param options - Header field values including authorization and optional content type.
 * @returns Header record suitable for a `fetch` call.
 */
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

/**
 * Encodes a UTF-8 string as a base64url value.
 *
 * @param value - Plain text to encode.
 * @returns Base64url-encoded string.
 */
export function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Removes a trailing slash from a URL string when present.
 *
 * @param value - URL string to normalise.
 * @returns URL without a trailing slash.
 */
export function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Resolves and validates a request timeout value.
 *
 * @param value - Timeout in milliseconds, or `undefined` for the default (10 000 ms).
 * @returns Validated timeout as a floored integer.
 * @throws {@link Error} when the value is non-finite or non-positive.
 */
export function resolveRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 10_000;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid requestTimeoutMs value: ${String(value)}`);
  }

  return Math.floor(value);
}

/**
 * Parses a GitHub REST API response as JSON.
 *
 * @typeParam ResponseValue - Expected JSON response shape.
 * @param response - Fetch response object.
 * @param method - HTTP method used for error reporting.
 * @param requestUrl - Request URL used for error reporting.
 * @returns Parsed response body.
 * @throws {@link GitHubApiError} when the response status is not ok.
 */
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

/**
 * Parses a GitHub GraphQL API response and extracts typed data.
 *
 * @typeParam T - Expected extracted data shape.
 * @param response - Fetch response object.
 * @param requestUrl - Request URL used for error reporting.
 * @param extractData - Callback to extract typed data from the raw GraphQL response.
 * @returns Extracted data from the GraphQL response.
 * @throws {@link GitHubApiError} when the HTTP response status is not ok.
 * @throws {@link GitHubGraphQlError} when the GraphQL response contains errors.
 */
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
