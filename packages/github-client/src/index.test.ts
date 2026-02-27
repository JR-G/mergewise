import { createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createCheckRun,
  createPullRequestReview,
  updateCheckRun,
  updateIssueComment,
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequest,
  fetchPullRequestFiles,
  GitHubApiError,
  GitHubGraphQlError,
  listPullRequestInlineComments,
  listPullRequestSummaryComments,
  minimizeComment,
  postPullRequestInlineComment,
  postPullRequestSummaryComment,
} from "./index";

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface FetchCall {
  input: string | URL;
  init?: RequestInit;
}

function decodeJwtPart(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("github-client", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("createGitHubAppJwt creates valid RS256 token with expected claims", () => {
    const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = keyPair.privateKey.export({
      format: "pem",
      type: "pkcs1",
    });

    const token = createGitHubAppJwt({
      appId: 12345,
      privateKeyPem,
      nowSeconds: 1_700_000_000,
    });
    const tokenParts = token.split(".");

    expect(tokenParts).toHaveLength(3);

    const header = decodeJwtPart(tokenParts[0]!) as { alg: string; typ: string };
    const payload = decodeJwtPart(tokenParts[1]!) as {
      iat: number;
      exp: number;
      iss: string;
    };
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iat).toBe(1_699_999_940);
    expect(payload.exp).toBe(1_700_000_600);
    expect(payload.iss).toBe("12345");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${tokenParts[0]}.${tokenParts[1]}`);
    verifier.end();
    const isValid = verifier.verify(
      keyPair.publicKey.export({ format: "pem", type: "pkcs1" }),
      tokenParts[2]!,
      "base64url",
    );
    expect(isValid).toBe(true);
  });

  test("exchangeInstallationAccessToken posts expected endpoint and returns token", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        token: "installation-token",
        expires_at: "2026-01-01T00:00:00Z",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await exchangeInstallationAccessToken("jwt-value", 44, {
      apiBaseUrl: "https://api.github.com",
      userAgent: "mergewise-tests",
    });

    expect(result.token).toBe("installation-token");
    expect(result.expires_at).toBe("2026-01-01T00:00:00Z");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/app/installations/44/access_tokens",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.signal).toBeDefined();
  });

  test("fetchPullRequestFiles paginates and returns combined files", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.includes("page=1")) {
        return makeJsonResponse([
          {
            filename: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
          },
          {
            filename: "src/b.ts",
            status: "added",
            additions: 3,
            deletions: 0,
            changes: 3,
          },
        ]);
      }

      return makeJsonResponse([
        {
          filename: "src/c.ts",
          status: "removed",
          additions: 0,
          deletions: 2,
          changes: 2,
        },
      ]);
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const files = await fetchPullRequestFiles({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 9,
      installationAccessToken: "installation-token",
      perPage: 2,
      maxPages: 5,
    });

    expect(files).toHaveLength(3);
    expect(files[0]!.filename).toBe("src/a.ts");
    expect(files[2]!.filename).toBe("src/c.ts");
    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.input)).toContain("page=1");
    expect(String(calls[1]!.input)).toContain("page=2");
  });

  test("postPullRequestSummaryComment sends markdown body and returns created comment", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 99,
        html_url: "https://github.com/acme/widget/pull/3#issuecomment-99",
        body: "summary",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await postPullRequestSummaryComment({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "installation-token",
      body: "summary",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-321",
    });

    expect(result.id).toBe(99);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ body: "summary" }));
    expect(calls[0]!.init?.signal).toBeDefined();
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-321");
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/issues/3/comments",
    );
  });

  test("postPullRequestInlineComment sends inline anchor payload and returns created comment", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 101,
        html_url: "https://github.com/acme/widget/pull/3#discussion_r101",
        body: "inline comment",
        path: "src/index.ts",
        line: 42,
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await postPullRequestInlineComment({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "installation-token",
      commitId: "abc123",
      path: "src/index.ts",
      line: 42,
      body: "inline comment",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-inline-1",
    });

    expect(result.id).toBe(101);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/pulls/3/comments",
    );
    expect(calls[0]!.init?.body).toBe(
      JSON.stringify({
        body: "inline comment",
        commit_id: "abc123",
        path: "src/index.ts",
        line: 42,
        side: "RIGHT",
      }),
    );
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-inline-1");
  });

  test("listPullRequestSummaryComments fetches summary comments", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse([
        {
          id: 201,
          node_id: "IC_kwDOtest201",
          html_url: "https://github.com/acme/widget/pull/3#issuecomment-201",
          body: "summary one",
        },
      ]);
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const comments = await listPullRequestSummaryComments({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "installation-token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-list-summary-1",
    });

    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/issues/3/comments?per_page=100&page=1",
    );
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-list-summary-1");
  });

  test("listPullRequestInlineComments fetches inline review comments", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse([
        {
          id: 301,
          node_id: "PRRC_kwDOtest301",
          html_url: "https://github.com/acme/widget/pull/3#discussion_r301",
          body: "inline one",
          path: "src/index.ts",
          line: 12,
        },
      ]);
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const comments = await listPullRequestInlineComments({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "installation-token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-list-inline-1",
    });

    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(301);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/pulls/3/comments?per_page=100&page=1",
    );
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-list-inline-1");
  });

  test("throws when requestTimeoutMs is invalid", async () => {
    let thrownError: unknown;
    try {
      await exchangeInstallationAccessToken("jwt-value", 44, {
        requestTimeoutMs: 0,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain("requestTimeoutMs");
  });

  test("throws GitHubApiError on non-success status", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "forbidden" }), { status: 403 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await exchangeInstallationAccessToken("jwt-value", 9);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    const apiError = thrownError as GitHubApiError;
    expect(apiError.status).toBe(403);
    expect(apiError.responseBody).toContain("forbidden");
  });

  test("createCheckRun sends correct request and returns created check run", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 999,
        html_url: "https://github.com/acme/widget/runs/999",
        status: "completed",
        conclusion: "success",
      }, 201);
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await createCheckRun({
      owner: "acme",
      repository: "widget",
      headSha: "abc123",
      installationAccessToken: "ghs_token",
      name: "Mergewise",
      conclusion: "success",
      output: {
        title: "Review completed",
        summary: "Rules=9/9 findings=0 posted=0",
        text: "### Reviewer Summary\nNo findings.",
      },
    });

    expect(result.id).toBe(999);
    expect(result.conclusion).toBe("success");
    expect(calls[0]).toBeDefined();
    const requestUrl = String(calls[0]!.input);
    expect(requestUrl).toContain("/repos/acme/widget/check-runs");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.signal).toBeDefined();
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(requestBody.name).toBe("Mergewise");
    expect(requestBody.head_sha).toBe("abc123");
    expect(requestBody.status).toBe("completed");
    expect(requestBody.conclusion).toBe("success");
    const requestOutput = requestBody.output as Record<string, unknown>;
    expect(requestOutput.title).toBe("Review completed");
  });

  test("createCheckRun throws GitHubApiError on failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "resource not accessible" }), { status: 403 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await createCheckRun({
        owner: "acme",
        repository: "widget",
        headSha: "abc123",
        installationAccessToken: "ghs_token",
        name: "Mergewise",
        conclusion: "success",
        output: { title: "test", summary: "test" },
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(403);
  });

  test("createCheckRun sends in_progress status without conclusion", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 500,
        html_url: "https://github.com/acme/widget/runs/500",
        status: "in_progress",
        conclusion: null,
      }, 201);
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await createCheckRun({
      owner: "acme",
      repository: "widget",
      headSha: "def456",
      installationAccessToken: "ghs_token",
      name: "Mergewise",
      status: "in_progress",
      output: { title: "Review in progress", summary: "Analysing pull request..." },
    });

    expect(result.id).toBe(500);
    expect(result.status).toBe("in_progress");
    expect(result.conclusion).toBeNull();
    expect(calls[0]).toBeDefined();
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(requestBody.status).toBe("in_progress");
    expect(requestBody.conclusion).toBeUndefined();
    expect(requestBody.head_sha).toBe("def456");
  });

  test("updateCheckRun PATCHes the correct endpoint and returns updated check run", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 500,
        html_url: "https://github.com/acme/widget/runs/500",
        status: "completed",
        conclusion: "success",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await updateCheckRun({
      owner: "acme",
      repository: "widget",
      checkRunId: 500,
      installationAccessToken: "ghs_token",
      status: "completed",
      conclusion: "success",
      output: {
        title: "Review completed",
        summary: "Rules=9/9 findings=2 posted=2",
        text: "### Reviewer Summary",
      },
      traceId: "trace-update-1",
    });

    expect(result.id).toBe(500);
    expect(result.conclusion).toBe("success");
    expect(calls[0]).toBeDefined();
    const requestUrl = String(calls[0]!.input);
    expect(requestUrl).toContain("/repos/acme/widget/check-runs/500");
    expect(calls[0]!.init?.method).toBe("PATCH");
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(requestBody.status).toBe("completed");
    expect(requestBody.conclusion).toBe("success");
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-update-1");
  });

  test("updateCheckRun throws GitHubApiError on failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await updateCheckRun({
        owner: "acme",
        repository: "widget",
        checkRunId: 999,
        installationAccessToken: "ghs_token",
        status: "completed",
        conclusion: "success",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(404);
  });

  test("fetchPullRequest returns parsed pull request state", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        number: 7,
        state: "open",
        merged: false,
        title: "Add feature X",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await fetchPullRequest({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 7,
      installationAccessToken: "installation-token",
      apiBaseUrl: "https://api.github.com",
      traceId: "trace-pr-1",
    });

    expect(result.number).toBe(7);
    expect(result.state).toBe("open");
    expect(result.merged).toBe(false);
    expect(result.title).toBe("Add feature X");
    expect(
      calls.some(
        (call) =>
          call.init?.method === "GET" &&
          String(call.input) === "https://api.github.com/repos/acme/widget/pulls/7",
      ),
    ).toBe(true);
    const prCall = calls.find(
      (call) => String(call.input) === "https://api.github.com/repos/acme/widget/pulls/7",
    );
    const requestHeaders = prCall!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-pr-1");
  });

  test("fetchPullRequest throws GitHubApiError on failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await fetchPullRequest({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 999,
        installationAccessToken: "installation-token",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(404);
  });

  test("createPullRequestReview sends batch review with inline comments and body", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 700,
        html_url: "https://github.com/acme/widget/pull/3#pullrequestreview-700",
        body: "review summary",
        state: "commented",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await createPullRequestReview({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 3,
      installationAccessToken: "ghs_token",
      commitId: "abc123",
      body: "review summary",
      event: "COMMENT",
      comments: [
        { path: "src/a.ts", line: 10, body: "comment one" },
        { path: "src/b.ts", line: 20, side: "LEFT", body: "comment two" },
      ],
      traceId: "trace-review-1",
    });

    expect(result.id).toBe(700);
    expect(result.state).toBe("commented");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/pulls/3/reviews",
    );
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(requestBody.commit_id).toBe("abc123");
    expect(requestBody.event).toBe("COMMENT");
    expect(requestBody.body).toBe("review summary");
    const comments = requestBody.comments as { path: string; line: number; side: string; body: string }[];
    expect(comments).toHaveLength(2);
    expect(comments[0]!.path).toBe("src/a.ts");
    expect(comments[0]!.side).toBe("RIGHT");
    expect(comments[1]!.side).toBe("LEFT");
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-review-1");
  });

  test("createPullRequestReview throws GitHubApiError on failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "validation failed" }), { status: 422 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await createPullRequestReview({
        owner: "acme",
        repository: "widget",
        pullRequestNumber: 3,
        installationAccessToken: "ghs_token",
        commitId: "abc123",
        event: "COMMENT",
        comments: [],
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(422);
  });

  test("minimizeComment sends GraphQL mutation and returns isMinimized", async () => {
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

  test("minimizeComment throws GitHubApiError on HTTP failure", async () => {
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

  test("minimizeComment throws GitHubGraphQlError on GraphQL errors", async () => {
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

  test("updateIssueComment PATCHes the correct endpoint and returns updated comment", async () => {
    const calls: FetchCall[] = [];
    const fetchMock: FetchMock = async (input, init) => {
      calls.push({ input, init });
      return makeJsonResponse({
        id: 42,
        node_id: "IC_42",
        html_url: "https://github.com/acme/widget/issues/5#issuecomment-42",
        body: "updated body",
      });
    };
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await updateIssueComment({
      owner: "acme",
      repository: "widget",
      commentId: 42,
      installationAccessToken: "ghs_token",
      body: "updated body",
      traceId: "trace-update-comment-1",
    });

    expect(result.id).toBe(42);
    expect(result.body).toBe("updated body");
    expect(calls[0]).toBeDefined();
    const requestUrl = String(calls[0]!.input);
    expect(requestUrl).toContain("/repos/acme/widget/issues/comments/42");
    expect(calls[0]!.init?.method).toBe("PATCH");
    const requestBody = JSON.parse(calls[0]!.init!.body as string) as Record<string, unknown>;
    expect(requestBody.body).toBe("updated body");
    const requestHeaders = calls[0]!.init?.headers as Record<string, string>;
    expect(requestHeaders["X-Mergewise-Trace-Id"]).toBe("trace-update-comment-1");
  });

  test("updateIssueComment throws GitHubApiError on failure", async () => {
    const fetchMock: FetchMock = async () =>
      new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    let thrownError: unknown;
    try {
      await updateIssueComment({
        owner: "acme",
        repository: "widget",
        commentId: 999,
        installationAccessToken: "ghs_token",
        body: "should fail",
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(GitHubApiError);
    expect((thrownError as GitHubApiError).status).toBe(404);
  });
});
