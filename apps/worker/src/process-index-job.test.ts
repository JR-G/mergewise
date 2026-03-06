import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import type { IndexRepoJob } from "@mergewise/shared-types";
import type { DebtProfile, DebtStore } from "@mergewise/debt-scanner";

import {
  processIndexRepoJob,
  type IndexJobDependencies,
} from "./process-index-job";

const FAKE_SCAN_ID = "scan-abc-123";

const STUB_PROFILE: DebtProfile = {
  repoPath: "/tmp/fake",
  scannedAt: new Date().toISOString(),
  graph: {
    nodes: new Map([["file:index.ts", {} as never]]),
    edges: [],
  },
  findings: [],
  hotspots: [
    {
      nodeId: "file:index.ts",
      filePath: "index.ts",
      score: 0.9,
      centrality: 0.5,
      signalDensity: 0.4,
      lineCount: 100,
    },
  ],
  totalFiles: 1,
  totalEdges: 0,
};

await mock.module("@mergewise/debt-scanner", () => ({
  scan: async () => STUB_PROFILE,
}));

const originalEnv = { ...process.env };

beforeAll(() => {
  process.env.GITHUB_APP_ID = "99999";
  process.env.GITHUB_APP_PRIVATE_KEY = "fake-pem-key-for-tests";
});

afterAll(() => {
  process.env.GITHUB_APP_ID = originalEnv.GITHUB_APP_ID;
  process.env.GITHUB_APP_PRIVATE_KEY = originalEnv.GITHUB_APP_PRIVATE_KEY;
});

function makeJob(overrides: Partial<IndexRepoJob> = {}): IndexRepoJob {
  return {
    type: "index-repo",
    job_id: "idx-job-1",
    installation_id: 42,
    repo_full_name: "acme/widget",
    default_branch: "main",
    head_sha: "abc123def456",
    trace_id: "trace-idx-1",
    queued_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDebtStore(
  overrides: Partial<DebtStore> = {},
): DebtStore {
  return {
    saveScan: () => FAKE_SCAN_ID,
    listScans: () => [],
    loadScan: () => null,
    latestScan: () => null,
    close: () => {},
    ...overrides,
  };
}

function baseDependencies(
  overrides: Partial<IndexJobDependencies> = {},
): IndexJobDependencies {
  return {
    debtStore: makeDebtStore(),
    createGitHubAppJwtFn: () => "jwt-token",
    exchangeInstallationAccessTokenFn: async () => ({
      token: "ghs_test_token",
      expires_at: "",
    }),
    spawnClone: async () => {},
    logInfo: () => {},
    logError: () => {},
    ...overrides,
  };
}

describe("processIndexRepoJob", () => {
  describe("happy path", () => {
    test("returns summary with correct repo name and sha", async () => {
      const result = await processIndexRepoJob(makeJob(), baseDependencies());

      expect(result.repoFullName).toBe("acme/widget");
      expect(result.headSha).toBe("abc123def456");
    });

    test("returns summary with node and hotspot counts from scan", async () => {
      const result = await processIndexRepoJob(makeJob(), baseDependencies());

      expect(result.nodeCount).toBe(STUB_PROFILE.graph.nodes.size);
      expect(result.hotspotCount).toBe(STUB_PROFILE.hotspots.length);
    });

    test("returns the scan ID from debtStore.saveScan", async () => {
      const customScanId = "custom-scan-id-789";
      const store = makeDebtStore({ saveScan: () => customScanId });
      const result = await processIndexRepoJob(
        makeJob(),
        baseDependencies({ debtStore: store }),
      );

      expect(result.scanId).toBe(customScanId);
    });

    test("persists scan result via debtStore.saveScan", async () => {
      const savedProfiles: DebtProfile[] = [];
      const store = makeDebtStore({
        saveScan: (profile) => {
          savedProfiles.push(profile);
          return FAKE_SCAN_ID;
        },
      });

      await processIndexRepoJob(makeJob(), baseDependencies({ debtStore: store }));

      expect(savedProfiles.length).toBeGreaterThan(0);
      expect(savedProfiles[0]!.repoPath).toBe("acme/widget");
    });

    test("logs index_start and index_complete messages", async () => {
      const logs: string[] = [];
      const dependencies = baseDependencies({
        logInfo: (message) => logs.push(message),
      });

      await processIndexRepoJob(makeJob(), dependencies);

      expect(logs.some((log) => log.includes("index_start"))).toBe(true);
      expect(logs.some((log) => log.includes("index_complete"))).toBe(true);
    });

    test("logs clone completion", async () => {
      const logs: string[] = [];
      const dependencies = baseDependencies({
        logInfo: (message) => logs.push(message),
      });

      await processIndexRepoJob(makeJob(), dependencies);

      expect(logs.some((log) => log.includes("index_clone_complete"))).toBe(true);
    });

    test("uses job_id as trace when trace_id is absent", async () => {
      const logs: string[] = [];
      const dependencies = baseDependencies({
        logInfo: (message) => logs.push(message),
      });

      await processIndexRepoJob(
        makeJob({ trace_id: undefined, job_id: "fallback-trace-job" }),
        dependencies,
      );

      expect(logs.some((log) => log.includes("trace=fallback-trace-job"))).toBe(true);
    });
  });

  describe("clone URL resolution", () => {
    test("includes auth token when installation_id is present", async () => {
      let capturedUrl = "";
      const dependencies = baseDependencies({
        exchangeInstallationAccessTokenFn: async () => ({
          token: "ghs_secret_token",
          expires_at: "",
        }),
        spawnClone: async (cloneUrl) => {
          capturedUrl = cloneUrl;
        },
      });

      await processIndexRepoJob(makeJob({ installation_id: 42 }), dependencies);

      expect(capturedUrl).toContain("x-access-token:ghs_secret_token@");
      expect(capturedUrl).toContain("github.com/acme/widget.git");
    });

    test("uses plain HTTPS URL when installation_id is null", async () => {
      let capturedUrl = "";
      const dependencies = baseDependencies({
        spawnClone: async (cloneUrl) => {
          capturedUrl = cloneUrl;
        },
      });

      await processIndexRepoJob(
        makeJob({ installation_id: null }),
        dependencies,
      );

      expect(capturedUrl).toBe("https://github.com/acme/widget.git");
      expect(capturedUrl).not.toContain("x-access-token");
    });

    test("passes installation_id to token exchange", async () => {
      let receivedInstallationId: number | undefined;
      const dependencies = baseDependencies({
        exchangeInstallationAccessTokenFn: async (_jwt, installationId) => {
          receivedInstallationId = installationId;
          return { token: "ghs_test", expires_at: "" };
        },
      });

      await processIndexRepoJob(makeJob({ installation_id: 777 }), dependencies);

      expect(receivedInstallationId).toBe(777);
    });
  });

  describe("clone failure", () => {
    test("propagates error when spawnClone throws", async () => {
      const dependencies = baseDependencies({
        spawnClone: async () => {
          throw new Error("clone failed: repository not found");
        },
      });

      let thrownError: unknown;
      try {
        await processIndexRepoJob(makeJob(), dependencies);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe("clone failed: repository not found");
    });

    test("logs index_failed when clone throws", async () => {
      const errors: string[] = [];
      const dependencies = baseDependencies({
        spawnClone: async () => {
          throw new Error("network timeout");
        },
        logError: (message) => errors.push(message),
      });

      try {
        await processIndexRepoJob(makeJob(), dependencies);
      } catch {
        /* expected */
      }

      expect(errors.some((log) => log.includes("index_failed"))).toBe(true);
      expect(errors.some((log) => log.includes("network timeout"))).toBe(true);
    });

    test("cleans up temp directory when clone throws", async () => {
      let capturedTargetDir = "";
      const dependencies = baseDependencies({
        spawnClone: async (_url, targetDir) => {
          capturedTargetDir = targetDir;
          throw new Error("clone failed");
        },
      });

      try {
        await processIndexRepoJob(makeJob(), dependencies);
      } catch {
        /* expected */
      }

      expect(capturedTargetDir).toContain("mergewise-index-");
      expect(existsSync(capturedTargetDir)).toBe(false);
    });
  });

  describe("scan failure", () => {
    test("propagates error when scan throws", async () => {
      await mock.module("@mergewise/debt-scanner", () => ({
        scan: async () => {
          throw new Error("AST parse failure");
        },
      }));

      const { processIndexRepoJob: freshProcessor } = await import(
        "./process-index-job"
      );

      let thrownError: unknown;
      try {
        await freshProcessor(makeJob(), baseDependencies());
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe("AST parse failure");

      await mock.module("@mergewise/debt-scanner", () => ({
        scan: async () => STUB_PROFILE,
      }));
    });

    test("cleans up temp directory when scan throws", async () => {
      let capturedTargetDir = "";

      await mock.module("@mergewise/debt-scanner", () => ({
        scan: async () => {
          throw new Error("scan boom");
        },
      }));

      const { processIndexRepoJob: freshProcessor } = await import(
        "./process-index-job"
      );

      const dependencies = baseDependencies({
        spawnClone: async (_url, targetDir) => {
          capturedTargetDir = targetDir;
        },
      });

      try {
        await freshProcessor(makeJob(), dependencies);
      } catch {
        /* expected */
      }

      expect(capturedTargetDir).toContain("mergewise-index-");
      expect(existsSync(capturedTargetDir)).toBe(false);

      await mock.module("@mergewise/debt-scanner", () => ({
        scan: async () => STUB_PROFILE,
      }));
    });
  });

  describe("temp directory cleanup", () => {
    test("removes temp directory on success", async () => {
      let capturedTargetDir = "";
      const dependencies = baseDependencies({
        spawnClone: async (_url, targetDir) => {
          capturedTargetDir = targetDir;
        },
      });

      await processIndexRepoJob(makeJob(), dependencies);

      expect(capturedTargetDir).toContain("mergewise-index-");
      expect(existsSync(capturedTargetDir)).toBe(false);
    });

    test("temp directory is created under system tmpdir", async () => {
      let capturedTargetDir = "";
      const dependencies = baseDependencies({
        spawnClone: async (_url, targetDir) => {
          capturedTargetDir = targetDir;
        },
      });

      await processIndexRepoJob(makeJob(), dependencies);

      expect(capturedTargetDir.startsWith(tmpdir())).toBe(true);
    });

    test("logs cleanup failure without throwing", async () => {
      const errors: string[] = [];
      const infos: string[] = [];
      const dependencies = baseDependencies({
        logInfo: (message) => infos.push(message),
        logError: (message) => errors.push(message),
      });

      await processIndexRepoJob(makeJob(), dependencies);

      expect(infos.some((log) => log.includes("index_complete"))).toBe(true);
    });
  });

  describe("error detail formatting", () => {
    test("includes stack trace in error log for Error instances", async () => {
      const errors: string[] = [];
      const dependencies = baseDependencies({
        spawnClone: async () => {
          throw new Error("detailed failure");
        },
        logError: (message) => errors.push(message),
      });

      try {
        await processIndexRepoJob(makeJob(), dependencies);
      } catch {
        /* expected */
      }

      const failedLog = errors.find((log) => log.includes("index_failed"));
      expect(failedLog).toBeDefined();
      expect(failedLog).toContain("detailed failure");
    });

    test("includes error message for Error subclasses in log", async () => {
      const errors: string[] = [];
      const dependencies = baseDependencies({
        spawnClone: async () => {
          throw new TypeError("type mismatch in clone");
        },
        logError: (message) => errors.push(message),
      });

      try {
        await processIndexRepoJob(makeJob(), dependencies);
      } catch {
        /* expected */
      }

      const failedLog = errors.find((log) => log.includes("index_failed"));
      expect(failedLog).toBeDefined();
      expect(failedLog).toContain("type mismatch in clone");
    });
  });

  describe("auth resolution", () => {
    test("creates JWT with app credentials from environment", async () => {
      let receivedConfig: { appId: number; privateKeyPem: string } | undefined;
      const dependencies = baseDependencies({
        createGitHubAppJwtFn: (config) => {
          receivedConfig = config as { appId: number; privateKeyPem: string };
          return "jwt-for-test";
        },
      });

      await processIndexRepoJob(makeJob({ installation_id: 42 }), dependencies);

      expect(receivedConfig).toBeDefined();
      expect(receivedConfig!.appId).toBe(99999);
      expect(receivedConfig!.privateKeyPem).toBe("fake-pem-key-for-tests");
    });

    test("passes JWT to token exchange function", async () => {
      let receivedJwt = "";
      const dependencies = baseDependencies({
        createGitHubAppJwtFn: () => "my-jwt-abc",
        exchangeInstallationAccessTokenFn: async (jwt) => {
          receivedJwt = jwt;
          return { token: "ghs_test", expires_at: "" };
        },
      });

      await processIndexRepoJob(makeJob({ installation_id: 42 }), dependencies);

      expect(receivedJwt).toBe("my-jwt-abc");
    });

    test("skips JWT and token exchange when installation_id is null", async () => {
      let jwtCalled = false;
      let tokenExchangeCalled = false;
      const dependencies = baseDependencies({
        createGitHubAppJwtFn: () => {
          jwtCalled = true;
          return "should-not-be-called";
        },
        exchangeInstallationAccessTokenFn: async () => {
          tokenExchangeCalled = true;
          return { token: "nope", expires_at: "" };
        },
      });

      await processIndexRepoJob(makeJob({ installation_id: null }), dependencies);

      expect(jwtCalled).toBe(false);
      expect(tokenExchangeCalled).toBe(false);
    });
  });
});
