import { createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
  fetchPullRequestFiles,
  GitHubApiError,
  postPullRequestSummaryComment,
} from "./index";

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

type FetchCall = {
  input: string | URL;
  init?: RequestInit;
};

function decodeJwtPart<TDecoded>(value: string): TDecoded {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TDecoded;
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
      privateKeyPem: privateKeyPem.toString(),
      nowSeconds: 1_700_000_000,
    });
    const tokenParts = token.split(".");

    expect(tokenParts).toHaveLength(3);

    const header = decodeJwtPart<{ alg: string; typ: string }>(tokenParts[0]!);
    const payload = decodeJwtPart<{ iat: number; exp: number; iss: string }>(
      tokenParts[1]!,
    );
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
    });

    expect(result.id).toBe(99);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ body: "summary" }));
    expect(calls[0]!.init?.signal).toBeDefined();
    expect(String(calls[0]!.input)).toBe(
      "https://api.github.com/repos/acme/widget/issues/3/comments",
    );
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
});
