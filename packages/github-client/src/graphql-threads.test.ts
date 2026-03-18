import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  GitHubApiError,
  GitHubGraphQlError,
  listPullRequestReviewThreads,
  listPullRequestReviewThreadsWithReplies,
} from "./index";
import type { FetchCall, FetchMock } from "./test-helpers";
import { makeJsonResponse } from "./test-helpers";

describe("listPullRequestReviewThreads", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches threads via GraphQL", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRT_kwDO1",
                    isResolved: false,
                    isOutdated: true,
                    comments: { nodes: [{ body: "<!-- mergewise-meta dedupeKey=acme/widget#3:finding-a -->" }] },
                  },
                  {
                    id: "PRT_kwDO2",
                    isResolved: true,
                    isOutdated: false,
                    comments: { nodes: [{ body: "some other comment" }] },
                  },
                ],
              },
            },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreads({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "ghs_token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-threads-1",
    });

    expect(threads).toHaveLength(2);
    expect(threads[0]!.id).toBe("PRT_kwDO1");
    expect(threads[0]!.isResolved).toBe(false);
    expect(threads[0]!.isOutdated).toBe(true);
    expect(threads[0]!.firstCommentBody).toContain("mergewise-meta");
    expect(threads[1]!.id).toBe("PRT_kwDO2");
    expect(threads[1]!.isResolved).toBe(true);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe("https://api.github.com/graphql");
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(requestBody.query).toContain("reviewThreads");
    expect(requestBody.variables["owner"]).toBe("acme");
    expect(requestBody.variables["name"]).toBe("widget");
    expect(requestBody.variables["prNumber"]).toBe(3);
  });

  test("paginates using cursor", async () => {
    let callCount = 0;
    const fetchMock: FetchMock = async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeJsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                  nodes: [{ id: "PRT_1", isResolved: false, isOutdated: false, comments: { nodes: [{ body: "page 1" }] } }],
                },
              },
            },
          },
        });
      }
      return makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "PRT_2", isResolved: false, isOutdated: true, comments: { nodes: [{ body: "page 2" }] } }],
              },
            },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreads({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 5,
      installationAccessToken: "ghs_token",
    });

    expect(threads).toHaveLength(2);
    expect(threads[0]!.id).toBe("PRT_1");
    expect(threads[1]!.id).toBe("PRT_2");
    expect(callCount).toBe(2);
  });

  test("stops after maxPages cap", async () => {
    let callCount = 0;
    const fetchMock: FetchMock = async () => {
      callCount += 1;
      return makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: `cursor-${callCount}` },
                nodes: [{ id: `PRT_page${callCount}`, isResolved: false, isOutdated: false, comments: { nodes: [{ body: `page ${callCount}` }] } }],
              },
            },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreads({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 7,
      installationAccessToken: "ghs_token",
      maxPages: 3,
    });

    expect(callCount).toBe(3);
    expect(threads).toHaveLength(3);
  });

  test("throws GitHubApiError on HTTP failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await listPullRequestReviewThreads({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 1,
        installationAccessToken: "bad_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(401);
  });

  test("throws GitHubGraphQlError on GraphQL error payload", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: null,
        errors: [{ message: "some graphql error", type: "INTERNAL" }],
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await listPullRequestReviewThreads({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 1,
        installationAccessToken: "ghs_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubGraphQlError);
    expect((thrownError as GitHubGraphQlError).message).toContain("some graphql error");
  });
});

describe("listPullRequestReviewThreadsWithReplies", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches threads with full comment history", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRT_kwDO1",
                    comments: {
                      nodes: [
                        { body: "<!-- mergewise-meta -->", author: { login: "mergewise[bot]", id: "BOT_1" } },
                        { body: "we don't care about this in tests", author: { login: "alice" } },
                        { body: "agreed", author: { login: "bob" } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "ghs_token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-replies-1",
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe("PRT_kwDO1");
    expect(threads[0]!.firstCommentBody).toContain("mergewise-meta");
    expect(threads[0]!.comments).toHaveLength(3);
    expect(threads[0]!.comments[0]!.authorIsBot).toBe(true);
    expect(threads[0]!.comments[0]!.authorLogin).toBe("mergewise[bot]");
    expect(threads[0]!.comments[1]!.authorIsBot).toBe(false);
    expect(threads[0]!.comments[1]!.body).toBe("we don't care about this in tests");
    expect(calls).toHaveLength(1);
  });

  test("handles threads with no comments", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: "PRT_empty", comments: { nodes: [] } }],
              },
            },
          },
        },
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
    });

    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments).toHaveLength(0);
    expect(threads[0]!.firstCommentBody).toBe("");
  });

  test("handles null author gracefully", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRT_null_author",
                    comments: {
                      nodes: [{ body: "ghost comment", author: null }],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
    });

    expect(threads[0]!.comments[0]!.authorLogin).toBe("");
    expect(threads[0]!.comments[0]!.authorIsBot).toBe(false);
  });

  test("classifies bot by login suffix when GraphQL id is absent", async () => {
    const fetchMock: FetchMock = async () =>
      makeJsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRT_bot_suffix",
                    comments: {
                      nodes: [
                        { body: "automated comment", author: { login: "github-actions[bot]" } },
                        { body: "human reply", author: { login: "alice" } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const threads = await listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
    });

    expect(threads[0]!.comments[0]!.authorLogin).toBe("github-actions[bot]");
    expect(threads[0]!.comments[0]!.authorIsBot).toBe(true);
    expect(threads[0]!.comments[1]!.authorIsBot).toBe(false);
  });

  test("throws GitHubApiError on non-2xx response", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await listPullRequestReviewThreadsWithReplies({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
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
        errors: [{ message: "Could not resolve to a PullRequest", type: "NOT_FOUND" }],
      });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await listPullRequestReviewThreadsWithReplies({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 999,
        installationAccessToken: "ghs_token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubGraphQlError);
    expect((thrownError as GitHubGraphQlError).message).toContain("Could not resolve");
  });
});
