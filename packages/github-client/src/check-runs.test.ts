import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createCheckRun, updateCheckRun, sanitizeCheckRunOutput } from "./check-runs";
import { GitHubApiError } from "./http";

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface FetchCall {
  input: string | URL;
  init?: RequestInit | undefined;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("check-runs", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("createCheckRun", () => {
    it("sends a POST with correct URL, body, and returns the created check run", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 101,
          html_url: "https://github.com/acme/widget/runs/101",
          status: "completed",
          conclusion: "success",
        }, 201);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await createCheckRun({
        owner: "acme",
        repository: "widget",
        headSha: "sha-abc",
        installationAccessToken: "ghs_token",
        name: "Mergewise Review",
        conclusion: "success",
        output: { title: "Done", summary: "All clear" },
      });

      expect(result.id).toBe(101);
      expect(result.conclusion).toBe("success");
      expect(String(calls[0]!.input)).toContain("/repos/acme/widget/check-runs");
      expect(calls[0]!.init?.method).toBe("POST");
      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["name"]).toBe("Mergewise Review");
      expect(body["head_sha"]).toBe("sha-abc");
    });

    it("defaults status to completed when conclusion is provided and status is omitted", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", status: "completed", conclusion: "neutral" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await createCheckRun({
        owner: "o",
        repository: "r",
        headSha: "sha",
        installationAccessToken: "tok",
        name: "test",
        conclusion: "neutral",
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["status"]).toBe("completed");
    });

    it("defaults status to queued when neither status nor conclusion is provided", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", status: "queued", conclusion: null });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await createCheckRun({
        owner: "o",
        repository: "r",
        headSha: "sha",
        installationAccessToken: "tok",
        name: "test",
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["status"]).toBe("queued");
    });

    it("throws when status is completed but conclusion is missing", async () => {
      expect(() =>
        createCheckRun({
          owner: "o",
          repository: "r",
          headSha: "sha",
          installationAccessToken: "tok",
          name: "test",
          status: "completed",
        }),
      ).toThrow("conclusion is required");
    });

    it("omits conclusion from request body when not provided", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 2, html_url: "", status: "in_progress", conclusion: null });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await createCheckRun({
        owner: "o",
        repository: "r",
        headSha: "sha",
        installationAccessToken: "tok",
        name: "test",
        status: "in_progress",
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["conclusion"]).toBeUndefined();
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await createCheckRun({
          owner: "o",
          repository: "r",
          headSha: "sha",
          installationAccessToken: "tok",
          name: "test",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(403);
    });
  });

  describe("updateCheckRun", () => {
    it("sends a PATCH to the correct endpoint with the check run ID", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 500,
          html_url: "https://github.com/acme/widget/runs/500",
          status: "completed",
          conclusion: "failure",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await updateCheckRun({
        owner: "acme",
        repository: "widget",
        checkRunId: 500,
        installationAccessToken: "ghs_token",
        status: "completed",
        conclusion: "failure",
        output: { title: "Failed", summary: "2 issues found" },
      });

      expect(result.id).toBe(500);
      expect(result.conclusion).toBe("failure");
      expect(String(calls[0]!.input)).toContain("/repos/acme/widget/check-runs/500");
      expect(calls[0]!.init?.method).toBe("PATCH");
      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["status"]).toBe("completed");
      expect(body["conclusion"]).toBe("failure");
    });

    it("includes output in the request body when provided", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", status: "completed", conclusion: "success" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await updateCheckRun({
        owner: "o",
        repository: "r",
        checkRunId: 1,
        installationAccessToken: "tok",
        status: "completed",
        conclusion: "success",
        output: { title: "Title", summary: "Summary", text: "Details" },
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      const output = body["output"] as Record<string, unknown>;
      expect(output["title"]).toBe("Title");
      expect(output["text"]).toBe("Details");
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await updateCheckRun({
          owner: "o",
          repository: "r",
          checkRunId: 999,
          installationAccessToken: "tok",
          status: "completed",
          conclusion: "neutral",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(404);
    });

    it("throws when status is completed but conclusion is missing", () => {
      expect(() =>
        updateCheckRun({
          owner: "o",
          repository: "r",
          checkRunId: 1,
          installationAccessToken: "tok",
          status: "completed",
        }),
      ).toThrow("conclusion is required");
    });

    it("sends empty output body when output is omitted", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", status: "completed", conclusion: "success" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await updateCheckRun({
        owner: "o",
        repository: "r",
        checkRunId: 1,
        installationAccessToken: "tok",
        status: "completed",
        conclusion: "success",
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["output"]).toBeUndefined();
    });
  });

  describe("sanitizeCheckRunOutput", () => {
    it("passes through short values unchanged", () => {
      const output = sanitizeCheckRunOutput({ title: "OK", summary: "All clear" });
      expect(output.title).toBe("OK");
      expect(output.summary).toBe("All clear");
    });

    it("truncates title exceeding 255 characters", () => {
      const longTitle = "x".repeat(300);
      const output = sanitizeCheckRunOutput({ title: longTitle, summary: "s" });
      expect(output.title.length).toBeLessThanOrEqual(255);
      expect(output.title.endsWith("\u2026")).toBe(true);
    });

    it("truncates summary exceeding 65535 characters", () => {
      const longSummary = "y".repeat(70_000);
      const output = sanitizeCheckRunOutput({ title: "t", summary: longSummary });
      expect(output.summary.length).toBeLessThanOrEqual(65_535);
      expect(output.summary.endsWith("\u2026")).toBe(true);
    });

    it("truncates text exceeding 65535 characters", () => {
      const longText = "z".repeat(70_000);
      const output = sanitizeCheckRunOutput({ title: "t", summary: "s", text: longText });
      expect(output.text!.length).toBeLessThanOrEqual(65_535);
      expect(output.text!.endsWith("\u2026")).toBe(true);
    });

    it("truncates emoji content without splitting surrogate pairs", () => {
      const emoji = "\u{1F600}";
      const emojiTitle = emoji.repeat(300);
      const output = sanitizeCheckRunOutput({ title: emojiTitle, summary: "s" });
      expect(output.title.endsWith("\u2026")).toBe(true);
      expect(output.title).not.toMatch(/[\uD800-\uDBFF]$/);
    });

    it("omits text from output when text is undefined", () => {
      const output = sanitizeCheckRunOutput({ title: "t", summary: "s" });
      expect("text" in output).toBe(false);
    });
  });
});
