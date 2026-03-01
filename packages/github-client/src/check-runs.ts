import {
  type GitHubApiOptions,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

/**
 * Request options for creating a check run on a commit.
 */
export interface CreateCheckRunOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Commit SHA to attach the check run to.
   */
  headSha: string;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Display name for the check run shown in the PR checks tab.
   */
  name: string;
  /**
   * Check run status.
   *
   * @defaultValue `"completed"`
   */
  status?: "queued" | "in_progress" | "completed";
  /**
   * Check run conclusion. Required when status is "completed".
   */
  conclusion?: "success" | "failure" | "neutral";
  /**
   * Structured output displayed in the check run details.
   */
  output?: {
    readonly title: string;
    readonly summary: string;
    readonly text?: string;
  };
}

/**
 * Request options for updating an existing check run.
 */
export interface UpdateCheckRunOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Identifier of the check run to update.
   */
  checkRunId: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Check run status.
   */
  status: "in_progress" | "completed";
  /**
   * Check run conclusion. Required when status is "completed".
   */
  conclusion?: "success" | "failure" | "neutral";
  /**
   * Structured output displayed in the check run details.
   */
  output?: {
    readonly title: string;
    readonly summary: string;
    readonly text?: string;
  };
}

/**
 * Response shape for a created GitHub check run.
 */
export interface GitHubCheckRun {
  /**
   * Check run identifier.
   */
  id: number;
  /**
   * HTML URL for the check run.
   */
  html_url: string;
  /**
   * Check run status.
   */
  status: string;
  /**
   * Check run conclusion.
   */
  conclusion: string | null;
}

/**
 * Creates a check run on a commit via the GitHub Checks API.
 *
 * @param options - Check run creation options.
 * @returns Created check run payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function createCheckRun(
  options: CreateCheckRunOptions,
): Promise<GitHubCheckRun> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/check-runs`;
  const requestBody: Record<string, unknown> = {
    name: options.name,
    head_sha: options.headSha,
    status: options.status ?? "completed",
  };
  if (options.conclusion !== undefined) {
    requestBody.conclusion = options.conclusion;
  }
  if (options.output !== undefined) {
    requestBody.output = options.output;
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
  return parseResponse<GitHubCheckRun>(response, "POST", endpointUrl);
}

/**
 * Updates an existing check run via the GitHub Checks API.
 *
 * @param options - Check run update options.
 * @returns Updated check run payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function updateCheckRun(
  options: UpdateCheckRunOptions,
): Promise<GitHubCheckRun> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl =
    `${apiBaseUrl}/repos/${encodeURIComponent(options.owner)}` +
    `/${encodeURIComponent(options.repository)}` +
    `/check-runs/${options.checkRunId}`;
  const requestBody: Record<string, unknown> = {
    status: options.status,
  };
  if (options.conclusion !== undefined) {
    requestBody.conclusion = options.conclusion;
  }
  if (options.output !== undefined) {
    requestBody.output = options.output;
  }
  const response = await fetch(endpointUrl, {
    method: "PATCH",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  return parseResponse<GitHubCheckRun>(response, "PATCH", endpointUrl);
}
