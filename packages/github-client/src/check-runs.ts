import {
  type GitHubApiOptions,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

const MAX_TITLE_LENGTH = 255;
const MAX_SUMMARY_LENGTH = 65_535;
const MAX_TEXT_LENGTH = 65_535;

interface CheckRunOutput {
  readonly title: string;
  readonly summary: string;
  readonly text?: string | undefined;
}

/**
 * Truncates check run output fields to GitHub's size limits.
 *
 * @param output - Raw check run output to sanitise.
 * @returns Output with title, summary, and text truncated if necessary.
 */
export function sanitizeCheckRunOutput(output: CheckRunOutput): CheckRunOutput {
  const truncate = (value: string, maxLength: number): string =>
    value.length > maxLength ? value.slice(0, maxLength - 1) + "\u2026" : value;

  return {
    title: truncate(output.title, MAX_TITLE_LENGTH),
    summary: truncate(output.summary, MAX_SUMMARY_LENGTH),
    ...(output.text !== undefined ? { text: truncate(output.text, MAX_TEXT_LENGTH) } : {}),
  };
}

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
  status?: "queued" | "in_progress" | "completed" | undefined;
  /**
   * Check run conclusion. Required when status is "completed".
   */
  conclusion?: "success" | "failure" | "neutral" | undefined;
  /**
   * Structured output displayed in the check run details.
   */
  output?: {
    readonly title: string;
    readonly summary: string;
    readonly text?: string | undefined;
  } | undefined;
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
  conclusion?: "success" | "failure" | "neutral" | undefined;
  /**
   * Structured output displayed in the check run details.
   */
  output?: {
    readonly title: string;
    readonly summary: string;
    readonly text?: string | undefined;
  } | undefined;
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
  const resolvedStatus = options.status ?? (options.conclusion !== undefined ? "completed" : "queued");
  if (resolvedStatus === "completed" && options.conclusion === undefined) {
    throw new Error("conclusion is required when status is \"completed\"");
  }

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
    status: resolvedStatus,
  };
  if (options.conclusion !== undefined) {
    requestBody["conclusion"] = options.conclusion;
  }
  if (options.output !== undefined) {
    requestBody["output"] = sanitizeCheckRunOutput(options.output);
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
  if (options.status === "completed" && options.conclusion === undefined) {
    throw new Error("conclusion is required when status is \"completed\"");
  }

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
    requestBody["conclusion"] = options.conclusion;
  }
  if (options.output !== undefined) {
    requestBody["output"] = sanitizeCheckRunOutput(options.output);
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
