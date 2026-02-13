import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AnalyzePullRequestJob,
  GitHubPullRequestAction,
  GitHubPullRequestWebhookEvent,
} from "@mergewise/shared-types";

/**
 * Stable error envelope returned by webhook API failures.
 */
export interface WebhookErrorEnvelope {
  /**
   * Fixed status marker for error responses.
   */
  status: "error";
  /**
   * Correlation identifier for this request.
   */
  request_id: string;
  /**
   * Structured error details for clients and logs.
   */
  error: {
    /**
     * Machine-readable error code.
     */
    code: WebhookErrorCode;
    /**
     * Human-readable summary of the failure.
     */
    message: string;
  };
}

/**
 * Known webhook API error codes.
 */
export type WebhookErrorCode =
  | "method_not_allowed"
  | "event_ignored"
  | "invalid_signature"
  | "invalid_json_payload"
  | "unsupported_pull_request_payload"
  | "pull_request_action_ignored"
  | "queue_enqueue_failed";

/**
 * Structured event payload for webhook failure logs.
 */
export interface WebhookFailureLogEvent {
  /**
   * Stable log event name.
   */
  event: "webhook_request_failed";
  /**
   * Correlation identifier for this request.
   */
  request_id: string;
  /**
   * HTTP status returned to caller.
   */
  http_status: number;
  /**
   * Machine-readable error code.
   */
  error_code: WebhookErrorCode;
  /**
   * Human-readable failure summary.
   */
  message: string;
  /**
   * Optional GitHub event name.
   */
  github_event?: string | null;
  /**
   * Optional repository full name.
   */
  repo_full_name?: string;
  /**
   * Optional pull request number.
   */
  pr_number?: number;
  /**
   * Optional queue job id.
   */
  job_id?: string;
  /**
   * Optional serialized cause.
   */
  cause?: string;
}

/**
 * Resolves a request identifier from headers or generates a new UUID.
 *
 * @param request - Incoming request.
 * @returns Existing `x-request-id` value or a generated UUID.
 */
export function getRequestId(request: Request): string {
  const providedRequestId = request.headers.get("x-request-id")?.trim();
  if (providedRequestId) {
    return providedRequestId;
  }
  return randomUUID();
}

/**
 * Creates a JSON response with request id header propagation.
 *
 * @param body - Serializable response payload.
 * @param status - HTTP response status.
 * @param requestId - Correlation request id.
 * @returns JSON response with `x-request-id` header.
 */
export function createWebhookJsonResponse<T>(
  body: T,
  status: number,
  requestId: string,
): Response {
  return Response.json(body, {
    status,
    headers: {
      "x-request-id": requestId,
    },
  });
}

/**
 * Creates a standardized webhook API error response envelope.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable failure summary.
 * @param status - HTTP status code.
 * @param requestId - Correlation request id.
 * @returns JSON response with stable error shape.
 */
export function createWebhookErrorResponse(
  code: WebhookErrorCode,
  message: string,
  status: number,
  requestId: string,
): Response {
  return createWebhookJsonResponse<WebhookErrorEnvelope>(
    {
      status: "error",
      request_id: requestId,
      error: {
        code,
        message,
      },
    },
    status,
    requestId,
  );
}

/**
 * Emits a structured webhook failure log for operational debugging.
 *
 * @param logEvent - Structured failure event payload.
 */
export function logWebhookFailure(logEvent: WebhookFailureLogEvent): void {
  console.error(JSON.stringify(logEvent));
}

/**
 * Supported GitHub pull request actions that should queue analysis work.
 */
export const SUPPORTED_PULL_REQUEST_ACTIONS: ReadonlySet<GitHubPullRequestAction> =
  new Set(["opened", "reopened", "synchronize"]);

/**
 * Runtime configuration for the webhook API service.
 */
export interface WebhookApiConfig {
  /**
   * HTTP port for Bun server binding.
   */
  port: number;
  /**
   * Optional webhook secret used for `x-hub-signature-256` verification.
   */
  webhookSecret?: string;
}

/**
 * Resolves API runtime configuration from environment variables.
 *
 * @returns Validated runtime config with defaults applied.
 */
export function loadConfig(): WebhookApiConfig {
  const portRaw = process.env.WEBHOOK_PORT ?? "8787";
  const port = Number.parseInt(portRaw, 10);

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid WEBHOOK_PORT value: ${portRaw}`);
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  return { port, webhookSecret };
}

/**
 * Calculates GitHub HMAC SHA-256 signature for a raw request body.
 *
 * @param payload - Raw webhook request body.
 * @param secret - Shared webhook secret.
 * @returns GitHub-formatted signature value (`sha256=<hex>`).
 */
export function computeGitHubSignature(payload: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${digest}`;
}

/**
 * Validates the GitHub webhook signature if a secret is configured.
 *
 * @param payload - Raw webhook payload.
 * @param signatureHeader - `x-hub-signature-256` header from GitHub.
 * @param secret - Optional secret; when unset, verification is skipped.
 * @returns `true` if signature is valid or verification is disabled.
 */
export function isWebhookSignatureValid(
  payload: string,
  signatureHeader: string | null,
  secret?: string,
): boolean {
  if (!secret) {
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const expected = computeGitHubSignature(payload, secret);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(signatureHeader, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Narrowly validates that a payload looks like the pull request webhook shape.
 *
 * @param payload - Parsed JSON payload.
 * @returns `true` when required fields are present.
 */
export function isPullRequestWebhookEvent(
  payload: unknown,
): payload is GitHubPullRequestWebhookEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const event = payload as Partial<GitHubPullRequestWebhookEvent>;
  return (
    typeof event.action === "string" &&
    typeof event.repository?.full_name === "string" &&
    typeof event.pull_request?.number === "number" &&
    typeof event.pull_request?.head?.sha === "string"
  );
}

/**
 * Converts a pull request webhook event into a queue job payload.
 *
 * @param payload - Parsed and validated pull request webhook event.
 * @returns Local queue job payload.
 */
export function buildAnalyzePullRequestJob(
  payload: GitHubPullRequestWebhookEvent,
): AnalyzePullRequestJob {
  return {
    job_id: randomUUID(),
    installation_id: payload.installation?.id ?? null,
    repo_full_name: payload.repository.full_name,
    pr_number: payload.pull_request.number,
    head_sha: payload.pull_request.head.sha,
    queued_at: new Date().toISOString(),
  };
}
