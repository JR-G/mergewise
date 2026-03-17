import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
} from "@mergewise/github-client";
import { scan as defaultScan, type DebtStore, type ScanOptions } from "@mergewise/debt-scanner";
import type { DebtProfile } from "@mergewise/debt-scanner";
import type { IndexRepoJob } from "@mergewise/shared-types";

import { loadGitHubAppCredentials } from "./github-auth";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";

/**
 * Resolved clone target: public URL plus optional auth token and host.
 */
interface CloneTarget {
  readonly url: string;
  readonly token?: string;
  readonly host: string;
}

/**
 * Dependency overrides for index-repo job processing.
 */
export interface IndexJobDependencies {
  readonly debtStore: DebtStore;
  readonly githubApiBaseUrl?: string;
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  readonly scanFn?: (options: ScanOptions) => Promise<DebtProfile>;
  readonly spawnClone?: (url: string, targetDir: string, sha: string, token?: string) => Promise<void>;
  readonly logInfo?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

/**
 * Summary returned after an index-repo job completes.
 */
export interface IndexJobSummary {
  readonly repoFullName: string;
  readonly headSha: string;
  readonly nodeCount: number;
  readonly hotspotCount: number;
  readonly scanId: string;
}

const CLONE_TIMEOUT_MS = 120_000;

/**
 * Shallow-clones a repository at a specific commit and runs the debt
 * scanner to index its dependency graph and hotspots.
 *
 * @param job - The index-repo job to process.
 * @param dependencies - Dependency overrides for testing.
 * @returns Summary of the completed scan.
 */
export async function processIndexRepoJob(
  job: IndexRepoJob,
  dependencies: IndexJobDependencies,
): Promise<IndexJobSummary> {
  const logInfo = dependencies.logInfo ?? console.log;
  const logError = dependencies.logError ?? console.error;
  const traceId = job.trace_id ?? job.job_id;

  logInfo(
    `[worker] index_start trace=${traceId} repo=${job.repo_full_name} sha=${job.head_sha}`,
  );

  const cloneDir = mkdtempSync(join(tmpdir(), "mergewise-index-"));

  try {
    const cloneTarget = await resolveCloneTarget(job, dependencies);
    const cloneFn = dependencies.spawnClone ?? spawnShallowClone;
    await cloneFn(cloneTarget.url, cloneDir, job.head_sha, cloneTarget.token);

    logInfo(
      `[worker] index_clone_complete trace=${traceId} repo=${job.repo_full_name}`,
    );

    const scanFn = dependencies.scanFn ?? defaultScan;
    const profile = await scanFn({
      repoPath: cloneDir,
      skipLlm: true,
    });

    const scanId = dependencies.debtStore.saveScan({
      ...profile,
      repoPath: job.repo_full_name,
    });

    logInfo(
      `[worker] index_complete trace=${traceId} repo=${job.repo_full_name} scan=${scanId} nodes=${profile.graph.nodes.size} hotspots=${profile.hotspots.length}`,
    );

    return {
      repoFullName: job.repo_full_name,
      headSha: job.head_sha,
      nodeCount: profile.graph.nodes.size,
      hotspotCount: profile.hotspots.length,
      scanId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    logError(
      `[worker] index_failed trace=${traceId} repo=${job.repo_full_name}: ${detail}`,
    );
    throw error;
  } finally {
    try {
      rmSync(cloneDir, { recursive: true, force: true });
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      logError(
        `[worker] index_cleanup_failed trace=${traceId} dir=${cloneDir}: ${detail}`,
      );
    }
  }
}

/**
 * Derives the git clone host from a GitHub API base URL.
 */
export function resolveCloneHost(apiBaseUrl: string): string {
  try {
    const url = new URL(apiBaseUrl);
    if (url.hostname === "api.github.com") {
      return "github.com";
    }
    return url.hostname;
  } catch {
    return "github.com";
  }
}

async function resolveCloneTarget(
  job: IndexRepoJob,
  dependencies: IndexJobDependencies,
): Promise<CloneTarget> {
  const apiBaseUrl = dependencies.githubApiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  const host = resolveCloneHost(apiBaseUrl);
  const url = `https://${host}/${job.repo_full_name}.git`;

  if (job.installation_id === null) {
    return { url, host };
  }

  const credentials = loadGitHubAppCredentials();
  const createJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
  const exchangeTokenFn = dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;

  const jwt = createJwtFn({
    appId: credentials.appId,
    privateKeyPem: credentials.privateKeyPem,
  });
  const tokenResponse = await exchangeTokenFn(jwt, job.installation_id, { apiBaseUrl });

  return { url, token: tokenResponse.token, host };
}

/**
 * Builds a base64-encoded basic auth header value for git HTTP auth.
 */
export function buildAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

function buildAuthEnv(token: string, host: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: buildAuthHeader(token),
  };
}

async function spawnShallowClone(
  cloneUrl: string,
  targetDir: string,
  sha: string,
  token?: string,
): Promise<void> {
  const host = extractHostFromUrl(cloneUrl);
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (token) {
    Object.assign(env, buildAuthEnv(token, host));
  }

  await runGitCommand(["git", "init", targetDir], env);
  await runGitCommand(
    ["git", "-C", targetDir, "remote", "add", "origin", cloneUrl],
    env,
  );
  await runGitCommand(
    ["git", "-C", targetDir, "fetch", "--depth", "1", "origin", sha],
    env,
  );
  await runGitCommand(
    ["git", "-C", targetDir, "checkout", "FETCH_HEAD"],
    env,
  );
}

function extractHostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "github.com";
  }
}

async function runGitCommand(
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", env });

  let timer: ReturnType<typeof setTimeout>;
  const exitCode = await Promise.race([
    proc.exited.then((code) => {
      clearTimeout(timer);
      return code;
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`git command timed out after ${CLONE_TIMEOUT_MS}ms: ${args.join(" ")}`));
      }, CLONE_TIMEOUT_MS);
    }),
  ]);

  if (exitCode !== 0) {
    const stderr = scrubCredentials(await new Response(proc.stderr).text());
    throw new Error(`git command failed with exit code ${exitCode}: ${args.join(" ")}: ${stderr.slice(0, 500)}`);
  }
}

/**
 * Removes embedded access tokens from clone URLs in error output.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
