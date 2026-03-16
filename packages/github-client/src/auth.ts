import { createSign } from "node:crypto";
import {
  type GitHubApiOptions,
  buildHeaders,
  toBase64Url,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseResponse,
} from "./http";

/**
 * Runtime options for GitHub App JWT creation.
 */
export interface GitHubAppJwtOptions {
  /**
   * GitHub App identifier.
   */
  appId: number;
  /**
   * PEM-encoded RSA private key for signing the JWT.
   */
  privateKeyPem: string;
  /**
   * Optional current time override in seconds for deterministic testing.
   */
  nowSeconds?: number | undefined;
}

/**
 * Response payload returned by GitHub installation token exchange.
 */
export interface GitHubInstallationAccessToken {
  /**
   * Installation access token value.
   */
  token: string;
  /**
   * ISO timestamp for token expiration.
   */
  expires_at: string;
}

/**
 * Creates a GitHub App JWT signed with RS256.
 *
 * @param options - JWT creation options.
 * @returns Signed compact JWT string.
 */
export function createGitHubAppJwt(options: GitHubAppJwtOptions): string {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const issuedAt = nowSeconds - 60;
  const expiresAt = nowSeconds + 600;

  const jwtHeader = { alg: "RS256", typ: "JWT" };
  const jwtPayload = {
    iat: issuedAt,
    exp: expiresAt,
    iss: String(options.appId),
  };

  const encodedHeader = toBase64Url(JSON.stringify(jwtHeader));
  const encodedPayload = toBase64Url(JSON.stringify(jwtPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(options.privateKeyPem, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Exchanges an app JWT for an installation access token.
 *
 * @param appJwt - GitHub App JWT.
 * @param installationId - Installation identifier.
 * @param options - Optional API configuration.
 * @returns Installation access token payload.
 * @throws {@link GitHubApiError} when GitHub returns a non-success status.
 */
export async function exchangeInstallationAccessToken(
  appJwt: string,
  installationId: number,
  options: GitHubApiOptions = {},
): Promise<GitHubInstallationAccessToken> {
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const endpointUrl = `${trimTrailingSlash(apiBaseUrl)}/app/installations/${installationId}/access_tokens`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${appJwt}`,
      userAgent: options.userAgent,
      traceId: options.traceId,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  return parseResponse<GitHubInstallationAccessToken>(
    response,
    "POST",
    endpointUrl,
  );
}
