import { randomUUID } from "node:crypto";

import type {
  WebhookErrorCode,
  WebhookFailureLogEventInput,
  WebhookRequestBodyReadResult,
} from "./types";

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
export function createWebhookJsonResponse(
  body: unknown,
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
  return createWebhookJsonResponse(
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
export function logWebhookFailure(
  logEvent: WebhookFailureLogEventInput,
): void {
  const repositoryFullName = logEvent.repository_full_name ?? logEvent.repo_full_name;
  const pullRequestNumber = logEvent.pull_request_number ?? logEvent.pr_number;

  const serializedLogEvent = {
    ...logEvent,
    repository_full_name: repositoryFullName,
    pull_request_number: pullRequestNumber,
    repo_full_name: repositoryFullName,
    pr_number: pullRequestNumber,
  };

  console.error(JSON.stringify(serializedLogEvent));
}

/**
 * Reads request text and maps body stream failures to stable API errors.
 *
 * @param request - Incoming HTTP request.
 * @param requestId - Correlation request id.
 * @param githubEvent - Optional GitHub event header value.
 * @returns Success payload with raw body, or a prebuilt error response.
 */
export async function readWebhookRequestBody(
  request: Request,
  requestId: string,
  githubEvent: string | null,
): Promise<WebhookRequestBodyReadResult> {
  try {
    const rawBody = await request.text();
    return { ok: true, rawBody };
  } catch (error) {
    const cause = error instanceof Error ? error.stack ?? error.message : String(error);
    logWebhookFailure({
      event: "webhook_request_failed",
      request_id: requestId,
      http_status: 400,
      error_code: "request_body_read_failed",
      message: "Failed to read request body",
      github_event: githubEvent,
      cause,
    });

    return {
      ok: false,
      response: createWebhookErrorResponse(
        "request_body_read_failed",
        "Failed to read request body",
        400,
        requestId,
      ),
    };
  }
}
