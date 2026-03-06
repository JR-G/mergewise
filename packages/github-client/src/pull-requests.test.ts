import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { GitHubApiError } from "./http";
import {
  fetchFileContent,
  fetchPullRequest,
  fetchPullRequestFiles,
} from "./pull-requests";

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

describe("pull-requests", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchPullRequestFiles", () => {
    it("collects files across multiple pages and stops when a page is short", async () => {
      let callCount = 0;
      const fetchMock: FetchMock = async () => {
        callCount += 1;
        if (callCount === 1) {
          return makeJsonResponse([
            { filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
            { filename: "b.ts", status: "added", additions: 2, deletions: 0, changes: 2 },
          ]);
        }
        return makeJsonResponse([
          { filename: "c.ts", status: "removed", additions: 0, deletions: 1, changes: 1 },
        ]);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const files = await fetchPullRequestFiles({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 10,
        installationAccessToken: "tok",
        perPage: 2,
      });

      expect(files.some((file) => file.filename === "a.ts")).toBe(true);
      expect(files.some((file) => file.filename === "c.ts")).toBe(true);
      expect(callCount).toBe(2);
    });

    it("respects maxPages limit", async () => {
      let callCount = 0;
      const fetchMock: FetchMock = async () => {
        callCount += 1;
        return makeJsonResponse([
          { filename: `file-${callCount}.ts`, status: "modified", additions: 1, deletions: 0, changes: 1 },
        ]);
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await fetchPullRequestFiles({
        owner: "o",
        repository: "r",
        pullRequestNumber: 1,
        installationAccessToken: "tok",
        perPage: 1,
        maxPages: 3,
      });

      expect(callCount).toBe(3);
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await fetchPullRequestFiles({
          owner: "o",
          repository: "r",
          pullRequestNumber: 999,
          installationAccessToken: "tok",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(404);
    });
  });

  describe("fetchPullRequest", () => {
    it("returns parsed pull request state from the API response", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          number: 7,
          state: "open",
          merged: false,
          title: "Add widget",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await fetchPullRequest({
        owner: "acme",
        repository: "repo",
        pullRequestNumber: 7,
        installationAccessToken: "tok",
      });

      expect(result.number).toBe(7);
      expect(result.state).toBe("open");
      expect(result.merged).toBe(false);
      expect(result.title).toBe("Add widget");
      expect(String(calls[0]!.input)).toContain("/pulls/7");
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await fetchPullRequest({
          owner: "o",
          repository: "r",
          pullRequestNumber: 999,
          installationAccessToken: "tok",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
    });
  });

  describe("fetchFileContent", () => {
    it("returns decoded file content for a base64-encoded response", async () => {
      const encodedContent = Buffer.from("export default 42;", "utf8").toString("base64");
      const fetchMock: FetchMock = async () =>
        makeJsonResponse({ content: encodedContent, encoding: "base64" });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const content = await fetchFileContent({
        owner: "acme",
        repository: "repo",
        path: "src/index.ts",
        ref: "main",
        installationAccessToken: "tok",
      });

      expect(content).toBe("export default 42;");
    });

    it("returns null for a 404 response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const content = await fetchFileContent({
        owner: "acme",
        repository: "repo",
        path: "missing.ts",
        ref: "main",
        installationAccessToken: "tok",
      });

      expect(content).toBeNull();
    });

    it("returns null when encoding is not base64", async () => {
      const fetchMock: FetchMock = async () =>
        makeJsonResponse({ content: "raw text", encoding: "none" });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const content = await fetchFileContent({
        owner: "acme",
        repository: "repo",
        path: "file.txt",
        ref: "main",
        installationAccessToken: "tok",
      });

      expect(content).toBeNull();
    });

    it("throws GitHubApiError for non-404 error responses", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await fetchFileContent({
          owner: "o",
          repository: "r",
          path: "secret.ts",
          ref: "main",
          installationAccessToken: "tok",
        });
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(403);
    });

    it("encodes path segments in the request URL", async () => {
      const calls: FetchCall[] = [];
      const encodedContent = Buffer.from("content", "utf8").toString("base64");
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ content: encodedContent, encoding: "base64" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await fetchFileContent({
        owner: "acme",
        repository: "repo",
        path: "src/my file.ts",
        ref: "feat/branch",
        installationAccessToken: "tok",
      });

      const url = String(calls[0]!.input);
      expect(url).toContain("/contents/src/my%20file.ts");
      expect(url).toContain("ref=feat%2Fbranch");
    });
  });
});
