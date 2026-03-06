import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createGitHubAppJwt,
  exchangeInstallationAccessToken,
} from "@mergewise/github-client";
import { scan, type DebtStore } from "@mergewise/debt-scanner";
import type { IndexRepoJob } from "@mergewise/shared-types";

import { loadGitHubAppCredentials } from "./github-auth";

/**
 * Resolved clone target: public URL plus optional auth token.
 */
interface CloneTarget {
  readonly url: string;
  readonly token?: string;
}

/**
 * Dependency overrides for index-repo job processing.
 */
export interface IndexJobDependencies {
  readonly debtStore: DebtStore;
  readonly createGitHubAppJwtFn?: typeof createGitHubAppJwt;
  readonly exchangeInstallationAccessTokenFn?: typeof exchangeInstallationAccessToken;
  readonly spawnClone?: (url: string, targetDir: string, token?: string) => Promise<void>;
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
 * Shallow-clones a repository and runs the debt scanner to index its
 * dependency graph and hotspots.
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
    await cloneFn(cloneTarget.url, cloneDir, cloneTarget.token);

    logInfo(
      `[worker] index_clone_complete trace=${traceId} repo=${job.repo_full_name}`,
    );

    const profile = await scan({
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

async function resolveCloneTarget(
  job: IndexRepoJob,
  dependencies: IndexJobDependencies,
): Promise<CloneTarget> {
  const url = `https://github.com/${job.repo_full_name}.git`;

  if (job.installation_id === null) {
    return { url };
  }

  const credentials = loadGitHubAppCredentials();
  const createJwtFn = dependencies.createGitHubAppJwtFn ?? createGitHubAppJwt;
  const exchangeTokenFn = dependencies.exchangeInstallationAccessTokenFn ?? exchangeInstallationAccessToken;

  const jwt = createJwtFn({
    appId: credentials.appId,
    privateKeyPem: credentials.privateKeyPem,
  });
  const tokenResponse = await exchangeTokenFn(jwt, job.installation_id);

  return { url, token: tokenResponse.token };
}

/**
 * Builds a base64-encoded basic auth header value for git HTTP auth.
 */
export function buildAuthHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

async function spawnShallowClone(
  cloneUrl: string,
  targetDir: string,
  token?: string,
): Promise<void> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = buildAuthHeader(token);
  }

  const proc = Bun.spawn(
    ["git", "clone", "--depth", "1", "--single-branch", cloneUrl, targetDir],
    { stdout: "ignore", stderr: "pipe", env },
  );

  let timer: ReturnType<typeof setTimeout>;
  const exitCode = await Promise.race([
    proc.exited.then((code) => {
      clearTimeout(timer);
      return code;
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`git clone timed out after ${CLONE_TIMEOUT_MS}ms`));
      }, CLONE_TIMEOUT_MS);
    }),
  ]);

  if (exitCode !== 0) {
    const stderr = scrubCredentials(await new Response(proc.stderr).text());
    throw new Error(`git clone failed with exit code ${exitCode}: ${stderr.slice(0, 500)}`);
  }
}

/**
 * Removes embedded access tokens from clone URLs in error output.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}
