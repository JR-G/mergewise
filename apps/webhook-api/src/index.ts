import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AnalyzePullRequestJob,
  GitHubPullRequestAction,
  GitHubPullRequestWebhookEvent,
} from "@mergewise/shared-types";

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
