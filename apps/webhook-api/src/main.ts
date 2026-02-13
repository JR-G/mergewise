import { enqueueAnalyzePullRequestJob } from "@mergewise/job-store";

import {
  buildAnalyzePullRequestJob,
  createWebhookErrorResponse,
  createWebhookJsonResponse,
  getRequestId,
  isPullRequestWebhookEvent,
  isSupportedPullRequestAction,
  isWebhookSignatureValid,
  loadConfig,
  logWebhookFailure,
} from "./index";

const config = loadConfig();

Bun.serve({
  port: config.port,
  /**
   * Handles incoming GitHub webhook HTTP requests.
   *
   * @param request - Incoming HTTP request.
   * @returns HTTP response with intake status.
   */
  async fetch(request: Request): Promise<Response> {
    const requestId = getRequestId(request);
    const eventName = request.headers.get("x-github-event");

    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return createWebhookJsonResponse({ status: "ok", request_id: requestId }, 200, requestId);
    }

    if (request.method !== "POST") {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: requestId,
        http_status: 405,
        error_code: "method_not_allowed",
        message: "Method Not Allowed",
        github_event: eventName,
      });
      return createWebhookErrorResponse(
        "method_not_allowed",
        "Method Not Allowed",
        405,
        requestId,
      );
    }

    if (eventName !== "pull_request") {
      return createWebhookJsonResponse(
        { status: "ignored", request_id: requestId, reason: "event_ignored" },
        202,
        requestId,
      );
    }

    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-hub-signature-256");
    if (!isWebhookSignatureValid(rawBody, signatureHeader, config.webhookSecret)) {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: requestId,
        http_status: 401,
        error_code: "invalid_signature",
        message: "Invalid signature",
        github_event: eventName,
      });
      return createWebhookErrorResponse(
        "invalid_signature",
        "Invalid signature",
        401,
        requestId,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: requestId,
        http_status: 400,
        error_code: "invalid_json_payload",
        message: "Invalid JSON payload",
        github_event: eventName,
      });
      return createWebhookErrorResponse(
        "invalid_json_payload",
        "Invalid JSON payload",
        400,
        requestId,
      );
    }

    if (!isPullRequestWebhookEvent(payload)) {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: requestId,
        http_status: 400,
        error_code: "unsupported_pull_request_payload",
        message: "Unsupported pull_request payload",
        github_event: eventName,
      });
      return createWebhookErrorResponse(
        "unsupported_pull_request_payload",
        "Unsupported pull_request payload",
        400,
        requestId,
      );
    }

    if (!isSupportedPullRequestAction(payload.action)) {
      return createWebhookJsonResponse(
        { status: "ignored", request_id: requestId, reason: "pull_request_action_ignored" },
        202,
        requestId,
      );
    }

    const job = buildAnalyzePullRequestJob(payload);
    try {
      enqueueAnalyzePullRequestJob(job);
    } catch (error) {
      const cause = error instanceof Error ? error.stack ?? error.message : String(error);
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: requestId,
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        github_event: eventName,
        repository_full_name: job.repo_full_name,
        pull_request_number: job.pr_number,
        job_id: job.job_id,
        cause,
      });
      return createWebhookErrorResponse(
        "queue_enqueue_failed",
        "Failed to queue analysis job",
        503,
        requestId,
      );
    }

    console.log(
      JSON.stringify({
        event: "webhook_job_queued",
        request_id: requestId,
        job_id: job.job_id,
        repo_full_name: job.repo_full_name,
        pr_number: job.pr_number,
        head_sha: job.head_sha,
      }),
    );

    return createWebhookJsonResponse(
      {
        status: "queued",
        request_id: requestId,
        job_id: job.job_id,
        repo: job.repo_full_name,
        pr_number: job.pr_number,
      },
      200,
      requestId,
    );
  },
});

console.log(
  `[webhook-api] listening on :${config.port} (signature verification: ${config.webhookSecret ? "enabled" : "disabled"})`,
);
