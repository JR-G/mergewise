import { readFileSync } from "node:fs";

/**
 * Loads GitHub App credentials from environment variables.
 *
 * Reads `GITHUB_APP_ID` for the numeric app identifier and resolves the private
 * key from `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`, or the
 * legacy `GITHUB_APP_PRIVATE_KEY_PEM` variable.
 *
 * @returns Validated app ID and PEM-formatted private key.
 */
export function loadGitHubAppCredentials(): Readonly<{ appId: number; privateKeyPem: string }> {
  const appIdRaw = process.env["GITHUB_APP_ID"];
  if (!appIdRaw?.trim()) {
    throw new Error("[worker] missing GITHUB_APP_ID");
  }

  const appId = Number.parseInt(appIdRaw, 10);
  if (Number.isNaN(appId) || appId <= 0) {
    throw new Error(`[worker] invalid GITHUB_APP_ID value: ${appIdRaw}`);
  }

  const privateKeyPem = resolvePrivateKeyPem();
  return { appId, privateKeyPem };
}

function resolvePrivateKeyPem(): string {
  const preferredPrivateKeyRaw = process.env["GITHUB_APP_PRIVATE_KEY"];
  const privateKeyPathRaw = process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
  const privateKeyPath = privateKeyPathRaw?.trim();
  const legacyPrivateKeyRaw = process.env["GITHUB_APP_PRIVATE_KEY_PEM"];
  let privateKeyRaw = preferredPrivateKeyRaw ?? legacyPrivateKeyRaw;
  let privateKeyLoadedFromPath = false;

  if (privateKeyRaw === undefined && privateKeyPath) {
    try {
      privateKeyRaw = readFileSync(privateKeyPath, "utf8");
      privateKeyLoadedFromPath = true;
    } catch (caughtError) {
      const details =
        caughtError instanceof Error ? caughtError.message : String(caughtError);
      console.error(
        `[worker] failed to read key from GITHUB_APP_PRIVATE_KEY_PATH (${privateKeyPath}): ${details}`,
      );
      throw new Error(
        `[worker] failed to read GITHUB_APP_PRIVATE_KEY_PATH (${privateKeyPath}): ${details}`,
        { cause: caughtError },
      );
    }
  }

  if (privateKeyRaw === undefined) {
    throw new Error(
      "[worker] missing GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH or legacy GITHUB_APP_PRIVATE_KEY_PEM)",
    );
  }

  const privateKeyPem = privateKeyRaw.replace(/\\n/g, "\n").trim();
  if (!privateKeyPem) {
    const invalidKeyVariableName = preferredPrivateKeyRaw !== undefined
      ? "GITHUB_APP_PRIVATE_KEY"
      : privateKeyLoadedFromPath
      ? "GITHUB_APP_PRIVATE_KEY_PATH"
      : "GITHUB_APP_PRIVATE_KEY_PEM";
    throw new Error(`[worker] invalid ${invalidKeyVariableName} value: empty`);
  }

  return privateKeyPem;
}
