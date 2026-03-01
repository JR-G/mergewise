/**
 * Known webhook API error codes.
 */
export type WebhookErrorCode =
  | "method_not_allowed"
  | "invalid_signature"
  | "request_body_read_failed"
  | "invalid_json_payload"
  | "unsupported_pull_request_payload"
  | "queue_enqueue_failed";

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
  repository_full_name?: string;
  /**
   * Optional pull request number.
   */
  pull_request_number?: number;
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
 * Legacy webhook failure log field aliases kept for backward compatibility.
 */
export interface LegacyWebhookFailureLogAliases {
  /**
   * Deprecated alias for `repository_full_name`.
   */
  repo_full_name?: string;
  /**
   * Deprecated alias for `pull_request_number`.
   */
  pr_number?: number;
}

/**
 * Accepted webhook failure log input with canonical and legacy aliases.
 */
export interface WebhookFailureLogEventInput
  extends WebhookFailureLogEvent,
    LegacyWebhookFailureLogAliases {}

/**
 * Result of reading an incoming webhook request body.
 */
export type WebhookRequestBodyReadResult =
  | {
      /**
       * Indicates request body read succeeded.
       */
      ok: true;
      /**
       * Raw request body text.
       */
      rawBody: string;
    }
  | {
      /**
       * Indicates request body read failed.
       */
      ok: false;
      /**
       * Prebuilt API error response for request body read failures.
       */
      response: Response;
    };

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
  /**
   * GitHub App identifier for pending check run creation.
   */
  githubAppId?: number;
  /**
   * GitHub App private key PEM for pending check run creation.
   */
  githubAppPrivateKeyPem?: string;
}
