import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  listPullRequestInlineComments,
  listPullRequestSummaryComments,
  postPullRequestInlineComment,
  postPullRequestSummaryComment,
  updateIssueComment,
} from "./comments";
import { GitHubApiError } from "./http";
import type { FetchCall, FetchMock } from "./test-helpers";
import { makeJsonResponse } from "./test-helpers";

describe("comments", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("postPullRequestSummaryComment", () => {
    it("posts to the issues comments endpoint and returns the created comment", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 50,
          node_id: "IC_50",
          html_url: "https://github.com/acme/repo/pull/1#issuecomment-50",
          body: "PR summary",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await postPullRequestSummaryComment({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        body: "PR summary",
      });

      expect(result.id).toBe(50);
      expect(result.body).toBe("PR summary");
      expect(String(calls[0]!.input)).toContain("/issues/1/comments");
      expect(calls[0]!.init?.method).toBe("POST");
    });

    it("throws GitHubApiError on failure", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await postPullRequestSummaryComment({
          owner: "o",
          repository: "r",
          pullRequestNumber: 1,
          installationAccessToken: "tok",
          body: "test",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(403);
    });
  });

  describe("postPullRequestInlineComment", () => {
    it("sends line anchor payload with default RIGHT side", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 60,
          node_id: "PRRC_60",
          html_url: "https://github.com/acme/repo/pull/2#discussion_r60",
          body: "inline note",
          path: "src/foo.ts",
          line: 10,
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await postPullRequestInlineComment({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 2,
        installationAccessToken: "tok",
        commitId: "sha-abc",
        path: "src/foo.ts",
        line: 10,
        body: "inline note",
      });

      expect(result.id).toBe(60);
      expect(String(calls[0]!.input)).toContain("/pulls/2/comments");
      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["side"]).toBe("RIGHT");
      expect(body["line"]).toBe(10);
      expect(body["path"]).toBe("src/foo.ts");
    });

    it("clamps line to minimum of 1 for zero or negative values", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 61,
          node_id: "PRRC_61",
          html_url: "",
          body: "test",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await postPullRequestInlineComment({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        commitId: "sha",
        path: "file.ts",
        line: -5,
        body: "test",
      });

      const body = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      expect(body["line"]).toBe(1);
    });
  });

  describe("listPullRequestSummaryComments", () => {
    it("stops pagination when a page returns fewer items than perPage", async () => {
      let callCount = 0;
      const fetchMock: FetchMock = async () => {
        callCount += 1;
        return makeJsonResponse([
          { id: callCount, node_id: `IC_${callCount}`, html_url: "", body: `comment ${callCount}` },
        ]);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const comments = await listPullRequestSummaryComments({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 5,
        installationAccessToken: "tok",
        perPage: 100,
        maxPages: 10,
      });

      expect(comments).toHaveLength(1);
      expect(callCount).toBe(1);
    });

    it("clamps perPage to maximum of 100", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse([]);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await listPullRequestSummaryComments({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        perPage: 999,
      });

      expect(String(calls[0]!.input)).toContain("per_page=100");
    });
  });

  describe("listPullRequestInlineComments", () => {
    it("fetches from the pulls comments endpoint", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse([
          { id: 1, node_id: "PRRC_1", html_url: "", body: "inline", path: "a.ts", line: 5 },
        ]);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const comments = await listPullRequestInlineComments({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 3,
        installationAccessToken: "tok",
      });

      expect(comments).toHaveLength(1);
      expect(String(calls[0]!.input)).toContain("/pulls/3/comments");
      expect(calls[0]!.init?.method).toBe("GET");
    });
  });

  describe("updateIssueComment", () => {
    it("PATCHes the issues comments endpoint with updated body", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 42,
          node_id: "IC_42",
          html_url: "",
          body: "new body",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await updateIssueComment({
        owner: "acme",
        repository: "repo",
        commentId: 42,
        installationAccessToken: "tok",
        body: "new body",
      });

      expect(result.id).toBe(42);
      expect(result.body).toBe("new body");
      expect(String(calls[0]!.input)).toContain("/issues/comments/42");
      expect(calls[0]!.init?.method).toBe("PATCH");
    });
  });
});
