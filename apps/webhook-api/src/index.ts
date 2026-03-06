import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  createCheckRun,
  updateCheckRun,
} from "@mergewise/github-client";

import type {
  AnalyzePullRequestJob,
  CollectFeedbackJob,
  GitHubPullRequestAction,
  GitHubPullRequestWebhookEvent,
} from "@mergewise/shared-types";

import type { WebhookApiConfig } from "./types";

export type {
  WebhookErrorCode,
  WebhookErrorEnvelope,
  WebhookFailureLogEvent,
  LegacyWebhookFailureLogAliases,
  WebhookFailureLogEventInput,
  WebhookRequestBodyReadResult,
  WebhookApiConfig,
} from "./types";

export {
  getRequestId,
  createWebhookJsonResponse,
  createWebhookErrorResponse,
  logWebhookFailure,
  readWebhookRequestBody,
} from "./request-handling";

/**
 * Supported GitHub pull request actions that should queue analysis work.
 */
const SUPPORTED_PULL_REQUEST_ACTION_VALUES = [
  "opened",
  "reopened",
  "synchronize",
] as const satisfies readonly GitHubPullRequestAction[];

/**
 * Supported GitHub pull request actions that should queue analysis work.
 */
export const SUPPORTED_PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set(
  SUPPORTED_PULL_REQUEST_ACTION_VALUES,
);

/**
 * Checks whether a pull request action should queue analysis work.
 *
 * @param action - Action name from webhook payload.
 * @returns `true` when action is supported for queueing.
 */
export function isSupportedPullRequestAction(
  action: string,
): action is GitHubPullRequestAction {
  return SUPPORTED_PULL_REQUEST_ACTIONS.has(action);
}

/**
 * Returns whether the webhook payload represents a draft pull request.
 *
 * @param payload - Parsed pull request webhook event.
 * @returns `true` when the PR is a draft.
 */
export function isDraftPullRequest(
  payload: GitHubPullRequestWebhookEvent,
): boolean {
  return payload.pull_request.draft === true;
}

/**
 * Returns whether the webhook payload represents a closed or merged pull request.
 *
 * @param payload - Parsed pull request webhook event.
 * @returns `true` when the PR is closed or merged.
 */
export function isClosedOrMergedPullRequest(
  payload: GitHubPullRequestWebhookEvent,
): boolean {
  return payload.pull_request.state === "closed" || payload.pull_request.merged === true;
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

  const appIdRaw = process.env.GITHUB_APP_ID;
  const githubAppId = appIdRaw ? Number.parseInt(appIdRaw, 10) : undefined;
  const githubAppPrivateKeyPem = resolvePrivateKeyPem();

  return { port, webhookSecret, githubAppId, githubAppPrivateKeyPem };
}

/**
 * Resolves the GitHub App private key PEM from environment variables.
 *
 * Checks `GITHUB_APP_PRIVATE_KEY` (inline PEM) first, then falls back to
 * `GITHUB_APP_PRIVATE_KEY_PATH` (file path) to match the worker's resolution
 * order.
 *
 * @returns Normalised PEM string, or `undefined` when no key is configured.
 */
function resolvePrivateKeyPem(): string | undefined {
  const inlineKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inlineKeyRaw !== undefined) {
    const normalised = inlineKeyRaw.replace(/\\n/g, "\n").trim();
    return normalised !== "" ? normalised : undefined;
  }

  const keyPathRaw = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const keyPath = keyPathRaw?.trim();
  if (!keyPath) {
    return undefined;
  }

  try {
    const fileContent = readFileSync(keyPath, "utf8");
    const normalised = fileContent.replace(/\\n/g, "\n").trim();
    return normalised !== "" ? normalised : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: "private_key_file_read_failed",
        path: keyPath,
        error: detail,
      }),
    );
    return undefined;
  }
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
    typeof event.pull_request?.head?.sha === "string" // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- head is nested inside optional pull_request
  );
}

/**
 * Converts a pull request webhook event into a queue job payload.
 *
 * @param payload - Parsed and validated pull request webhook event.
 * @param traceId - Optional end-to-end trace identifier sourced from request handling.
 * @returns Local queue job payload.
 */
export function buildAnalyzePullRequestJob(
  payload: GitHubPullRequestWebhookEvent,
  traceId?: string,
): AnalyzePullRequestJob {
  return {
    job_id: randomUUID(),
    installation_id: payload.installation?.id ?? null,
    repo_full_name: payload.repository.full_name,
    pr_number: payload.pull_request.number,
    head_sha: payload.pull_request.head.sha,
    trace_id: traceId,
    queued_at: new Date().toISOString(),
  };
}

/**
 * Converts a pull request close/merge webhook event into a feedback collection job payload.
 *
 * @param payload - Parsed and validated pull request webhook event.
 * @param traceId - Optional end-to-end trace identifier sourced from request handling.
 * @returns Local queue job payload for feedback collection.
 */
export function buildCollectFeedbackJob(
  payload: GitHubPullRequestWebhookEvent,
  traceId?: string,
): CollectFeedbackJob {
  return {
    type: "collect-feedback",
    job_id: randomUUID(),
    installation_id: payload.installation?.id ?? null,
    repo_full_name: payload.repository.full_name,
    pr_number: payload.pull_request.number,
    trace_id: traceId,
    queued_at: new Date().toISOString(),
  };
}

/**
 * Dependency overrides for `createPendingCheckRun`.
 */
export interface CreatePendingCheckRunDependencies {
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  readonly createCheckRunFn?: typeof createCheckRun;
}

/**
 * Creates a "queued" check run so Mergewise appears in the PR checks list immediately.
 *
 * Best-effort — returns `null` on any failure or missing config so it never blocks enqueue.
 *
 * @param payload - Parsed pull request webhook event.
 * @param config - Webhook API runtime config (must include App credentials).
 * @param dependencies - Optional dependency overrides for testing.
 * @returns Check run id on success, `null` otherwise.
 */
export async function createPendingCheckRun(
  payload: GitHubPullRequestWebhookEvent,
  config: WebhookApiConfig,
  dependencies: CreatePendingCheckRunDependencies = {},
): Promise<number | null> {
  if (!config.githubAppId || !config.githubAppPrivateKeyPem) {
    console.error(
      JSON.stringify({
        event: "pending_check_run_skipped",
        reason: "missing_app_credentials",
        repository_full_name: payload.repository.full_name,
        pull_request_number: payload.pull_request.number,
        has_app_id: config.githubAppId !== undefined,
        has_private_key: config.githubAppPrivateKeyPem !== undefined,
      }),
    );
    return null;
  }

  const installationId = payload.installation?.id;
  if (installationId === undefined) {
    console.error(
      JSON.stringify({
        event: "pending_check_run_skipped",
        reason: "missing_installation_id",
        repository_full_name: payload.repository.full_name,
        pull_request_number: payload.pull_request.number,
      }),
    );
    return null;
  }

  try {
    const createJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
    const exchangeTokenFn = dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;
    const createRunFn = dependencies.createCheckRunFn ?? createCheckRun;

    const jwt = createJwtFn({ appId: config.githubAppId, privateKeyPem: config.githubAppPrivateKeyPem });
    const token = await exchangeTokenFn(jwt, installationId);

    const [owner, repository] = payload.repository.full_name.split("/");
    if (!owner || !repository) {
      return null;
    }

    const checkRun = await createRunFn({
      owner,
      repository,
      headSha: payload.pull_request.head.sha,
      installationAccessToken: token.token,
      name: "Mergewise",
      status: "queued",
      output: { title: "Queued", summary: "Waiting for analysis to begin..." },
    });

    return checkRun.id;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: "pending_check_run_failed",
        repository_full_name: payload.repository.full_name,
        pull_request_number: payload.pull_request.number,
        error: detail,
      }),
    );
    return null;
  }
}

/**
 * Best-effort cancellation of a queued check run when enqueue fails.
 *
 * @param checkRunId - Check run to cancel.
 * @param payload - Original webhook payload for auth context.
 * @param config - Webhook API config with App credentials.
 * @param dependencies - Optional dependency overrides for testing.
 */
export async function cancelOrphanedCheckRun(
  checkRunId: number,
  payload: GitHubPullRequestWebhookEvent,
  config: WebhookApiConfig,
  dependencies: {
    readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
    readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
    readonly updateCheckRunFn?: typeof updateCheckRun;
  } = {},
): Promise<void> {
  if (!config.githubAppId || !config.githubAppPrivateKeyPem) {
    return;
  }

  const installationId = payload.installation?.id;
  if (installationId === undefined) {
    return;
  }

  try {
    const createJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
    const exchangeTokenFn = dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;
    const updateRunFn = dependencies.updateCheckRunFn ?? updateCheckRun;

    const jwt = createJwtFn({ appId: config.githubAppId, privateKeyPem: config.githubAppPrivateKeyPem });
    const token = await exchangeTokenFn(jwt, installationId);

    const [owner, repository] = payload.repository.full_name.split("/");
    if (!owner || !repository) {
      return;
    }

    await updateRunFn({
      owner,
      repository,
      checkRunId,
      installationAccessToken: token.token,
      status: "completed",
      conclusion: "failure",
      output: { title: "Queue failed", summary: "Failed to enqueue analysis job." },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      `[webhook-api] failed to cancel orphaned check run ${checkRunId}: ${detail}`,
    );
  }
}
