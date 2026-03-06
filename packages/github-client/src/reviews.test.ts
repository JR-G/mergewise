import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { GitHubApiError } from "./http";
import { createPullRequestReview } from "./reviews";

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

describe("reviews", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("createPullRequestReview", () => {
    it("sends a POST to the reviews endpoint and returns the review payload", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          id: 200,
          html_url: "https://github.com/acme/repo/pull/5#pullrequestreview-200",
          body: "review body",
          state: "commented",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await createPullRequestReview({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 5,
        installationAccessToken: "tok",
        commitId: "sha-xyz",
        event: "COMMENT",
        body: "review body",
        comments: [
          { path: "src/a.ts", line: 10, body: "suggestion" },
        ],
      });

      expect(result.id).toBe(200);
      expect(result.state).toBe("commented");
      expect(String(calls[0]!.input)).toContain("/pulls/5/reviews");
      expect(calls[0]!.init?.method).toBe("POST");
    });

    it("defaults comment side to RIGHT when not specified", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", body: null, state: "commented" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await createPullRequestReview({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        commitId: "sha",
        event: "COMMENT",
        comments: [{ path: "file.ts", line: 5, body: "note" }],
      });

      const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      const comments = requestBody["comments"] as { side: string }[];
      expect(comments[0]!.side).toBe("RIGHT");
    });

    it("filters out comments with invalid line numbers", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", body: null, state: "commented" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await createPullRequestReview({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        commitId: "sha",
        event: "COMMENT",
        comments: [
          { path: "valid.ts", line: 5, body: "ok" },
          { path: "zero.ts", line: 0, body: "filtered" },
          { path: "negative.ts", line: -1, body: "filtered" },
          { path: "float.ts", line: 3.7, body: "filtered" },
        ],
      });

      const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      const comments = requestBody["comments"] as { path: string }[];
      expect(comments).toHaveLength(1);
      expect(comments[0]!.path).toBe("valid.ts");
    });

    it("truncates comments beyond the maximum count of 50", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ id: 1, html_url: "", body: null, state: "commented" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const manyComments = Array.from({ length: 60 }, (_, index) => ({
        path: `file-${index}.ts`,
        line: index + 1,
        body: `comment ${index}`,
      }));

      await createPullRequestReview({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        commitId: "sha",
        event: "COMMENT",
        comments: manyComments,
      });

      const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
      const comments = requestBody["comments"] as unknown[];
      expect(comments).toHaveLength(50);
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "validation failed" }), { status: 422 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await createPullRequestReview({
          owner: "o",
          repository: "r",
          pullRequestNumber: 1,
          installationAccessToken: "tok",
          commitId: "sha",
          event: "COMMENT",
          comments: [],
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(422);
    });
  });
});
