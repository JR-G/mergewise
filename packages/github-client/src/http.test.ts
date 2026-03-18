import { describe, expect, it } from "bun:test";

import {
  GitHubApiError,
  GitHubGraphQlError,
  buildHeaders,
  parseGraphQlResponse,
  parseResponse,
  resolveRequestTimeoutMs,
  toBase64Url,
  trimTrailingSlash,
} from "./http";
import { makeJsonResponse } from "./test-helpers";

describe("http", () => {
  describe("buildHeaders", () => {
    it("includes required headers with default user agent", () => {
      const headers = buildHeaders({ authorization: "Bearer tok" });

      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(headers["Accept"]).toBe("application/vnd.github+json");
      expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
      expect(headers["User-Agent"]).toBe("mergewise-github-client");
    });

    it("includes Content-Type and trace ID when provided", () => {
      const headers = buildHeaders({
        authorization: "Bearer tok",
        contentType: "application/json",
        traceId: "trace-123",
      });

      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Mergewise-Trace-Id"]).toBe("trace-123");
    });

    it("uses custom user agent when provided", () => {
      const headers = buildHeaders({
        authorization: "Bearer tok",
        userAgent: "custom-agent/1.0",
      });

      expect(headers["User-Agent"]).toBe("custom-agent/1.0");
    });

    it("omits Content-Type and trace ID headers when not provided", () => {
      const headers = buildHeaders({ authorization: "Bearer tok" });

      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers["X-Mergewise-Trace-Id"]).toBeUndefined();
    });
  });

  describe("toBase64Url", () => {
    it("encodes a plain string to base64url", () => {
      const encoded = toBase64Url('{"alg":"RS256"}');
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      expect(decoded).toBe('{"alg":"RS256"}');
    });

    it("returns an empty string for empty input", () => {
      expect(toBase64Url("")).toBe("");
    });

    it("handles unicode characters", () => {
      const encoded = toBase64Url("hello \u00e9\u00e8");
      const decoded = Buffer.from(encoded, "base64url").toString("utf8");
      expect(decoded).toBe("hello \u00e9\u00e8");
    });
  });

  describe("trimTrailingSlash", () => {
    it("removes a trailing slash", () => {
      expect(trimTrailingSlash("https://api.github.com/")).toBe("https://api.github.com");
    });

    it("returns the value unchanged when there is no trailing slash", () => {
      expect(trimTrailingSlash("https://api.github.com")).toBe("https://api.github.com");
    });

    it("handles an empty string", () => {
      expect(trimTrailingSlash("")).toBe("");
    });
  });

  describe("resolveRequestTimeoutMs", () => {
    it("returns 10000 when undefined", () => {
      expect(resolveRequestTimeoutMs(undefined)).toBe(10_000);
    });

    it("floors a valid positive float to an integer", () => {
      expect(resolveRequestTimeoutMs(5000.9)).toBe(5000);
    });

    it("throws for zero", () => {
      expect(() => resolveRequestTimeoutMs(0)).toThrow("requestTimeoutMs");
    });

    it("throws for negative values", () => {
      expect(() => resolveRequestTimeoutMs(-100)).toThrow("requestTimeoutMs");
    });

    it("throws for NaN", () => {
      expect(() => resolveRequestTimeoutMs(NaN)).toThrow("requestTimeoutMs");
    });

    it("throws for Infinity", () => {
      expect(() => resolveRequestTimeoutMs(Infinity)).toThrow("requestTimeoutMs");
    });
  });

  describe("parseResponse", () => {
    it("returns parsed JSON for a successful response", async () => {
      const response = makeJsonResponse({ key: "value" });
      const result = await parseResponse<{ key: string }>(response, "GET", "https://example.com");
      expect(result.key).toBe("value");
    });

    it("throws GitHubApiError for a non-ok response", async () => {
      const response = new Response(JSON.stringify({ message: "bad" }), { status: 422 });

      let thrownError: unknown;
      try {
        await parseResponse(response, "POST", "https://example.com/api");
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      const apiError = thrownError as GitHubApiError;
      expect(apiError.status).toBe(422);
      expect(apiError.method).toBe("POST");
      expect(apiError.url).toBe("https://example.com/api");
      expect(apiError.responseBody).toContain("bad");
    });

    it("throws when a 200 response contains malformed JSON", async () => {
      const response = new Response("not valid json {{{", { status: 200 });

      let thrownError: unknown;
      try {
        await parseResponse(response, "GET", "https://example.com/api");
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
    });
  });

  describe("parseGraphQlResponse", () => {
    it("extracts data using the provided callback", async () => {
      const response = makeJsonResponse({ data: { viewer: { login: "alice" } } });
      const result = await parseGraphQlResponse(
        response,
        "https://api.github.com/graphql",
        (data) => (data as { viewer: { login: string } }).viewer.login,
      );
      expect(result).toBe("alice");
    });

    it("throws GitHubApiError for a non-ok HTTP response", async () => {
      const response = new Response("server error", { status: 500 });

      let thrownError: unknown;
      try {
        await parseGraphQlResponse(response, "https://api.github.com/graphql", () => null);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(500);
    });

    it("throws when a 200 response contains malformed JSON", async () => {
      const response = new Response("not valid json {{{", { status: 200 });

      let thrownError: unknown;
      try {
        await parseGraphQlResponse(response, "https://api.github.com/graphql", () => null);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
    });

    it("throws GitHubGraphQlError when the response body contains errors", async () => {
      const response = makeJsonResponse({
        data: null,
        errors: [{ message: "Field not found", type: "NOT_FOUND" }],
      });

      let thrownError: unknown;
      try {
        await parseGraphQlResponse(response, "https://api.github.com/graphql", () => null);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubGraphQlError);
      expect((thrownError as GitHubGraphQlError).message).toContain("Field not found");
    });
  });

  describe("GitHubApiError", () => {
    it("exposes status, method, url, and responseBody on the error instance", () => {
      const error = new GitHubApiError(404, "GET", "https://api.github.com/repos/x", "not found");

      expect(error.status).toBe(404);
      expect(error.method).toBe("GET");
      expect(error.url).toBe("https://api.github.com/repos/x");
      expect(error.responseBody).toBe("not found");
      expect(error.name).toBe("GitHubApiError");
      expect(error.message).toContain("404");
    });
  });
});
