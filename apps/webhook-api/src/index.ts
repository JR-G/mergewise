import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { enqueueAnalyzePullRequestJob } from "@mergewise/job-store";
import type {
  AnalyzePullRequestJob,
  GitHubPullRequestAction,
  GitHubPullRequestWebhookEvent,
} from "@mergewise/shared-types";

/**
 * Supported GitHub pull request actions that should queue analysis work.
 */
const SUPPORTED_PULL_REQUEST_ACTIONS: ReadonlySet<GitHubPullRequestAction> =
  new Set(["opened", "reopened", "synchronize"]);

/**
 * Runtime configuration for the webhook API service.
 */
interface WebhookApiConfig {
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
function loadConfig(): WebhookApiConfig {
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
function computeGitHubSignature(payload: string, secret: string): string {
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
function isWebhookSignatureValid(
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
function isPullRequestWebhookEvent(
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
function buildAnalyzePullRequestJob(
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
