import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  GitHubApiError,
  GitHubGraphQlError,
  listPullRequestReviewThreadsWithReplies,
  minimizeComment,
  resolveReviewThread,
} from "./index";
import type { FetchCall, FetchMock } from "./test-helpers";
import { makeJsonResponse } from "./test-helpers";

describe("paginateGraphqlQuery validation", () => {
  test("rejects non-integer perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: 1.5,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects NaN perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: NaN,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects negative maxPages", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      maxPages: -1,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects zero maxPages", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      maxPages: 0,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects Infinity perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: Infinity,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });
});

describe("minimizeComment", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends GraphQL mutation and returns isMinimized", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        data: {
          minimizeComment: {
            minimizedComment: { isMinimized: true },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await minimizeComment({
      subjectId: "IC_kwDOtest123",
      classifier: "OUTDATED",
      installationAccessToken: "ghs_token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-minimize-1",
    });

    expect(result.isMinimized).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://api.github.com/graphql");
    expect(calls[0]!.init?.method).toBe("POST");
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as {
      query: string;
      variables: { subjectId: string; classifier: string };
    };
    expect(requestBody.variables.subjectId).toBe("IC_kwDOtest123");
    expect(requestBody.variables.classifier).toBe("OUTDATED");
    expect(requestBody.query).toContain("minimizeComment");
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-minimize-1");
  });

  test("throws GitHubApiError on HTTP failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await minimizeComment({
        subjectId: "IC_kwDOtest123",
        classifier: "OUTDATED",
        installationAccessToken: "bad_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(401);
  });

  test("throws GitHubGraphQlError on GraphQL errors", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: null,
        errors: [{ message: "Could not resolve to a node", type: "NOT_FOUND" }],
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await minimizeComment({
        subjectId: "IC_kwDObad",
        classifier: "OUTDATED",
        installationAccessToken: "ghs_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubGraphQlError);
    expect((thrownError as GitHubGraphQlError).message).toContain("Could not resolve");
  });
});

describe("resolveReviewThread", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends GraphQL mutation and returns isResolved", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        data: {
          resolveReviewThread: {
            thread: { isResolved: true },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await resolveReviewThread({
      threadId: "PRT_kwDOtest123",
      installationAccessToken: "ghs_token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-resolve-1",
    });

    expect(result.isResolved).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://api.github.com/graphql");
    expect(calls[0]!.init?.method).toBe("POST");
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as {
      query: string;
      variables: { threadId: string };
    };
    expect(requestBody.variables.threadId).toBe("PRT_kwDOtest123");
    expect(requestBody.query).toContain("resolveReviewThread");
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-resolve-1");
  });

  test("throws GitHubApiError on HTTP failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await resolveReviewThread({
        threadId: "PRT_kwDOtest123",
        installationAccessToken: "bad_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(401);
  });

  test("throws GitHubGraphQlError on GraphQL errors", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: null,
        errors: [{ message: "Could not resolve to a node", type: "NOT_FOUND" }],
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await resolveReviewThread({
        threadId: "PRT_kwDObad",
        installationAccessToken: "ghs_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubGraphQlError);
    expect((thrownError as GitHubGraphQlError).message).toContain("Could not resolve");
  });
});
