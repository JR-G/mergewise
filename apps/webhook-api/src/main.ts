import { enqueueAnalyzePullRequestJob, enqueueCollectFeedbackJob, enqueueIndexRepoJob } from "@mergewise/job-store";

import {
  buildAnalyzePullRequestJob,
  buildCollectFeedbackJob,
  buildIndexRepoJob,
  cancelOrphanedCheckRun,
  createPendingCheckRun,
  createWebhookErrorResponse,
  createWebhookJsonResponse,
  getRequestId,
  isClosedOrMergedPullRequest,
  isDefaultBranchPush,
  isDraftPullRequest,
  isPullRequestWebhookEvent,
  isPushWebhookEvent,
  isSupportedPullRequestAction,
  isWebhookSignatureValid,
  loadConfig,
  logWebhookFailure,
  readWebhookRequestBody,
} from "./index";

const config = loadConfig();

function handlePushEvent(
  payload: unknown,
  requestId: string,
  eventName: string,
): Response {
  if (!isPushWebhookEvent(payload)) {
    return createWebhookJsonResponse(
      { status: "ignored", request_id: requestId, reason: "unsupported_push_payload" },
      202,
      requestId,
    );
  }

  if (!isDefaultBranchPush(payload)) {
    return createWebhookJsonResponse(
      { status: "ignored", request_id: requestId, reason: "non_default_branch_push" },
      202,
      requestId,
    );
  }

  const indexJob = buildIndexRepoJob(payload, requestId);
  try {
    enqueueIndexRepoJob(indexJob);
  } catch (error) {
    const cause = error instanceof Error ? error.stack ?? error.message : String(error);
    logWebhookFailure({
      event: "webhook_request_failed",
      request_id: requestId,
      http_status: 503,
      error_code: "queue_enqueue_failed",
      message: "Failed to queue index-repo job",
      github_event: eventName,
      repository_full_name: indexJob.repo_full_name,
      job_id: indexJob.job_id,
      cause,
    });
    return createWebhookErrorResponse(
      "queue_enqueue_failed",
      "Failed to queue index-repo job",
      503,
      requestId,
    );
  }

  console.log(
    JSON.stringify({
      event: "webhook_index_job_queued",
      request_id: requestId,
      trace_id: indexJob.trace_id,
      job_id: indexJob.job_id,
      repo_full_name: indexJob.repo_full_name,
      head_sha: indexJob.head_sha,
      default_branch: indexJob.default_branch,
    }),
  );

  return createWebhookJsonResponse(
    {
      status: "queued",
      request_id: requestId,
      job_id: indexJob.job_id,
      repo: indexJob.repo_full_name,
    },
    200,
    requestId,
  );
}

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

    if (eventName !== "pull_request" && eventName !== "push") {
      return createWebhookJsonResponse(
        { status: "ignored", request_id: requestId, reason: "event_ignored" },
        202,
        requestId,
      );
    }

    const bodyReadResult = await readWebhookRequestBody(request, requestId, eventName);
    if (!bodyReadResult.ok) {
      return bodyReadResult.response;
    }

    const rawBody = bodyReadResult.rawBody;
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

    if (eventName === "push") {
      return handlePushEvent(payload, requestId, eventName);
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

    if (payload.action === "closed") {
      const feedbackJob = buildCollectFeedbackJob(payload, requestId);
      try {
        enqueueCollectFeedbackJob(feedbackJob);
      } catch (error) {
        const cause = error instanceof Error ? error.stack ?? error.message : String(error);
        logWebhookFailure({
          event: "webhook_request_failed",
          request_id: requestId,
          http_status: 503,
          error_code: "queue_enqueue_failed",
          message: "Failed to queue feedback collection job",
          github_event: eventName,
          repository_full_name: feedbackJob.repo_full_name,
          pull_request_number: feedbackJob.pr_number,
          job_id: feedbackJob.job_id,
          cause,
        });
        return createWebhookErrorResponse(
          "queue_enqueue_failed",
          "Failed to queue feedback collection job",
          503,
          requestId,
        );
      }

      process.stderr.write(`${JSON.stringify({
        event: "webhook_feedback_job_queued",
        request_id: requestId,
        http_status: 200,
        job_id: feedbackJob.job_id,
        repository_full_name: feedbackJob.repo_full_name,
        pull_request_number: feedbackJob.pr_number,
        github_event: eventName,
      })}\n`);

      return createWebhookJsonResponse(
        {
          status: "queued",
          request_id: requestId,
          job_id: feedbackJob.job_id,
          repo: feedbackJob.repo_full_name,
          pr_number: feedbackJob.pr_number,
        },
        200,
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

    if (isDraftPullRequest(payload)) {
      return createWebhookJsonResponse(
        { status: "ignored", request_id: requestId, reason: "draft_pull_request" },
        202,
        requestId,
      );
    }

    if (isClosedOrMergedPullRequest(payload)) {
      return createWebhookJsonResponse(
        { status: "ignored", request_id: requestId, reason: "closed_or_merged_pull_request" },
        202,
        requestId,
      );
    }

    const checkRunId = await createPendingCheckRun(payload, config);
    const job = buildAnalyzePullRequestJob(payload, requestId);
    if (checkRunId !== null) {
      job.check_run_id = checkRunId;
    }
    try {
      enqueueAnalyzePullRequestJob(job);
    } catch (error) {
      if (checkRunId !== null) {
        await cancelOrphanedCheckRun(checkRunId, payload, config);
      }
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
        trace_id: job.trace_id,
        job_id: job.job_id,
        repo_full_name: job.repo_full_name,
        pr_number: job.pr_number,
        head_sha: job.head_sha,
        check_run_id: checkRunId,
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
  `[webhook-api] listening on :${config.port} (signature verification: ${config.webhookSecret ? "enabled" : "disabled"}, pending check runs: ${config.githubAppId && config.githubAppPrivateKeyPem ? "enabled" : "disabled"})`,
);
