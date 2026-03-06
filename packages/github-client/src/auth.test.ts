import { createVerify, generateKeyPairSync } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createGitHubAppJwt, exchangeInstallationAccessToken } from "./auth";
import { GitHubApiError } from "./http";

type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface FetchCall {
  input: string | URL;
  init?: RequestInit | undefined;
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

describe("auth", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("createGitHubAppJwt", () => {
    it("produces a three-part JWT with RS256 header and correct claims", () => {
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({
        format: "pem",
        type: "pkcs1",
      });

      const token = createGitHubAppJwt({
        appId: 42,
        privateKeyPem,
        nowSeconds: 1_700_000_000,
      });
      const parts = token.split(".");

      expect(parts).toHaveLength(3);

      const header = decodeJwtPart(parts[0]!) as { alg: string; typ: string };
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");

      const payload = decodeJwtPart(parts[1]!) as { iat: number; exp: number; iss: string };
      expect(payload.iss).toBe("42");
      expect(payload.iat).toBe(1_699_999_940);
      expect(payload.exp).toBe(1_700_000_600);
    });

    it("creates a signature verifiable with the corresponding public key", () => {
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({
        format: "pem",
        type: "pkcs1",
      });

      const token = createGitHubAppJwt({
        appId: 99,
        privateKeyPem,
        nowSeconds: 1_700_000_000,
      });
      const parts = token.split(".");

      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${parts[0]}.${parts[1]}`);
      verifier.end();
      const isValid = verifier.verify(
        keyPair.publicKey.export({ format: "pem", type: "pkcs1" }),
        parts[2]!,
        "base64url",
      );
      expect(isValid).toBe(true);
    });

    it("throws when given an invalid PEM key", () => {
      expect(() =>
        createGitHubAppJwt({
          appId: 1,
          privateKeyPem: "not-a-real-pem",
          nowSeconds: 1_700_000_000,
        }),
      ).toThrow();
    });

    it("converts appId to a string issuer claim", () => {
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const privateKeyPem = keyPair.privateKey.export({
        format: "pem",
        type: "pkcs1",
      });

      const token = createGitHubAppJwt({
        appId: 0,
        privateKeyPem,
        nowSeconds: 1_700_000_000,
      });
      const parts = token.split(".");
      const payload = decodeJwtPart(parts[1]!) as { iss: string };
      expect(payload.iss).toBe("0");
    });
  });

  describe("exchangeInstallationAccessToken", () => {
    it("posts to the correct endpoint and returns the token payload", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({
          token: "ghs_abc123",
          expires_at: "2026-06-01T00:00:00Z",
        });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      const result = await exchangeInstallationAccessToken("jwt-value", 77, {
        apiBaseUrl: "https://api.github.com",
      });

      expect(result.token).toBe("ghs_abc123");
      expect(result.expires_at).toBe("2026-06-01T00:00:00Z");
      expect(String(calls[0]!.input)).toBe(
        "https://api.github.com/app/installations/77/access_tokens",
      );
      expect(calls[0]!.init?.method).toBe("POST");
    });

    it("throws GitHubApiError on non-success response", async () => {
      const fetchMock: FetchMock = async () =>
        new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await exchangeInstallationAccessToken("bad-jwt", 1);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(GitHubApiError);
      expect((thrownError as GitHubApiError).status).toBe(401);
    });

    it("surfaces network errors when fetch rejects", async () => {
      globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof globalThis.fetch;

      let thrownError: unknown;
      try {
        await exchangeInstallationAccessToken("jwt-value", 1);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(TypeError);
      expect((thrownError as TypeError).message).toBe("fetch failed");
    });

    it("strips trailing slash from custom apiBaseUrl", async () => {
      const calls: FetchCall[] = [];
      const fetchMock: FetchMock = async (input, init) => {
        calls.push({ input, init });
        return makeJsonResponse({ token: "tok", expires_at: "2026-01-01T00:00:00Z" });
      };
      globalThis.fetch = fetchMock as typeof globalThis.fetch;

      await exchangeInstallationAccessToken("jwt", 10, {
        apiBaseUrl: "https://ghe.example.com/api/v3/",
      });

      expect(String(calls[0]!.input)).toBe(
        "https://ghe.example.com/api/v3/app/installations/10/access_tokens",
      );
    });
  });
});
