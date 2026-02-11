import { enqueueAnalyzePullRequestJob } from "@mergewise/job-store";
import type { GitHubPullRequestAction } from "@mergewise/shared-types";

import {
  buildAnalyzePullRequestJob,
  isPullRequestWebhookEvent,
  isWebhookSignatureValid,
  loadConfig,
  SUPPORTED_PULL_REQUEST_ACTIONS,
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
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const eventName = request.headers.get("x-github-event");
    if (eventName !== "pull_request") {
      return new Response("Ignored event", { status: 202 });
    }

    const rawBody = await request.text();
    const signatureHeader = request.headers.get("x-hub-signature-256");
    if (!isWebhookSignatureValid(rawBody, signatureHeader, config.webhookSecret)) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON payload", { status: 400 });
    }

    if (!isPullRequestWebhookEvent(payload)) {
      return new Response("Unsupported pull_request payload", { status: 400 });
    }

    if (
      !SUPPORTED_PULL_REQUEST_ACTIONS.has(
        payload.action as GitHubPullRequestAction,
      )
    ) {
      return new Response("Ignored pull_request action", { status: 202 });
    }

    const job = buildAnalyzePullRequestJob(payload);
    try {
      enqueueAnalyzePullRequestJob(job);
    } catch (error) {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(
        `[webhook-api] failed to enqueue job=${job.job_id} repo=${job.repo_full_name} pr=${job.pr_number}: ${details}`,
      );
      return Response.json(
        { status: "error", message: "Failed to queue analysis job" },
        { status: 503 },
      );
    }

    console.log(
      `[webhook-api] queued job=${job.job_id} repo=${job.repo_full_name} pr=${job.pr_number} sha=${job.head_sha}`,
    );

    return Response.json({
      status: "queued",
      job_id: job.job_id,
      repo: job.repo_full_name,
      pr_number: job.pr_number,
    });
  },
});

console.log(
  `[webhook-api] listening on :${config.port} (signature verification: ${config.webhookSecret ? "enabled" : "disabled"})`,
);
