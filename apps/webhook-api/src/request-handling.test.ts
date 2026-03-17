import { describe, expect, test } from "bun:test";

import {
  createWebhookErrorResponse,
  createWebhookJsonResponse,
  getRequestId,
  logWebhookFailure,
  readWebhookRequestBody,
} from "./request-handling";

describe("getRequestId", () => {
  test("uses existing x-request-id header", () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "x-request-id": "external-request-id",
      },
    });

    expect(getRequestId(request)).toBe("external-request-id");
  });

  test("generates uuid when header is missing", () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
    });

    expect(getRequestId(request)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("createWebhookJsonResponse", () => {
  test("propagates request id as response header", async () => {
    const response = createWebhookJsonResponse(
      { status: "ok", request_id: "test-request-id" },
      200,
      "test-request-id",
    );

    expect(response.headers.get("x-request-id")).toBe("test-request-id");
    expect(await response.json()).toEqual({
      status: "ok",
      request_id: "test-request-id",
    });
  });
});

describe("createWebhookErrorResponse", () => {
  test("returns standard error envelope", async () => {
    const response = createWebhookErrorResponse(
      "invalid_signature",
      "Invalid signature",
      401,
      "request-123",
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(await response.json()).toEqual({
      status: "error",
      request_id: "request-123",
      error: {
        code: "invalid_signature",
        message: "Invalid signature",
      },
    });
  });
});

describe("readWebhookRequestBody", () => {
  test("returns raw body when request text succeeds", async () => {
    const request = new Request("http://localhost/webhook", {
      method: "POST",
      body: '{"ok":true}',
    });

    const result = await readWebhookRequestBody(
      request,
      "request-100",
      "pull_request",
    );

    expect(result).toEqual({
      ok: true,
      rawBody: '{"ok":true}',
    });
  });

  test("returns typed error response when request body read fails", async () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    const failingRequest = {
      text: async (): Promise<string> => {
        throw new Error("body stream failed");
      },
    } as unknown as Request;

    try {
      const result = await readWebhookRequestBody(
        failingRequest,
        "request-101",
        "pull_request",
      );

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected request body read to fail");
      }

      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("x-request-id")).toBe("request-101");
      expect(await result.response.json()).toEqual({
        status: "error",
        request_id: "request-101",
        error: {
          code: "request_body_read_failed",
          message: "Failed to read request body",
        },
      });
    } finally {
      console.error = originalConsoleError;
    }

    const loggedPayload = JSON.parse(String(capturedLogs[0])) as {
      error_code: string;
      message: string;
      request_id: string;
      github_event: string;
      cause: string;
    };
    expect(loggedPayload.error_code).toBe("request_body_read_failed");
    expect(loggedPayload.message).toBe("Failed to read request body");
    expect(loggedPayload.request_id).toBe("request-101");
    expect(loggedPayload.github_event).toBe("pull_request");
    expect(loggedPayload.cause).toContain("body stream failed");
  });
});

describe("logWebhookFailure", () => {
  test("emits structured json logs", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-456",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
      });
    } finally {
      console.error = originalConsoleError;
    }

    const parsed: unknown = JSON.parse(capturedLogs[0] as string);
    expect(parsed).toMatchObject({
      event: "webhook_request_failed",
      request_id: "request-456",
      http_status: 503,
      error_code: "queue_enqueue_failed",
      message: "Failed to queue analysis job",
    });
  });

  test("serializes canonical repository and pull request fields", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-789",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repository_full_name: "acme/widget",
        pull_request_number: 7,
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toEqual([
      JSON.stringify({
        event: "webhook_request_failed",
        request_id: "request-789",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repository_full_name: "acme/widget",
        pull_request_number: 7,
        repo_full_name: "acme/widget",
        pr_number: 7,
      }),
    ]);
  });

  test("maps legacy aliases to canonical fields", () => {
    const originalConsoleError = console.error;
    const capturedLogs: unknown[] = [];
    console.error = (value?: unknown): void => {
      capturedLogs.push(value);
    };

    try {
      logWebhookFailure({
        event: "webhook_request_failed",
        request_id: "request-790",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repo_full_name: "acme/legacy",
        pr_number: 13,
      });
    } finally {
      console.error = originalConsoleError;
    }

    expect(capturedLogs).toEqual([
      JSON.stringify({
        event: "webhook_request_failed",
        request_id: "request-790",
        http_status: 503,
        error_code: "queue_enqueue_failed",
        message: "Failed to queue analysis job",
        repo_full_name: "acme/legacy",
        pr_number: 13,
        repository_full_name: "acme/legacy",
        pull_request_number: 13,
      }),
    ]);
  });
});
