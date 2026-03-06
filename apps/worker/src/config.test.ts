import { afterEach, describe, expect, it } from "bun:test";

import {
  DEFAULT_ALLOWED_POST_CATEGORIES,
  DEFAULT_BLOCKED_POST_RULE_IDS,
  DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD,
  loadConfig,
  resolveGitHubFetchOptions,
} from "./config";

describe("config constants", () => {
  it("exports a test file confidence threshold between 0 and 1", () => {
    expect(DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_TEST_FILE_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("exports a non-empty allowed post categories list", () => {
    expect(DEFAULT_ALLOWED_POST_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("exports a non-empty blocked post rule IDs list", () => {
    expect(DEFAULT_BLOCKED_POST_RULE_IDS.length).toBeGreaterThan(0);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads custom values from environment variables", () => {
    process.env["WORKER_POLL_INTERVAL_MS"] = "5000";
    process.env["WORKER_MAX_PROCESSED_KEYS"] = "200";
    process.env["WORKER_GITHUB_FETCH_RETRIES"] = "3";
    process.env["WORKER_FINDING_MAX_COMMENTS"] = "10";

    const config = loadConfig();

    expect(config.pollIntervalMs).toBe(5000);
    expect(config.maxProcessedKeys).toBe(200);
    expect(config.githubFetchRetries).toBe(3);
    expect(config.maxComments).toBe(10);
  });

  it("rejects confidence threshold outside 0-1 range", () => {
    process.env["WORKER_FINDING_CONFIDENCE_THRESHOLD"] = "-0.5";
    expect(() => loadConfig()).toThrow("Invalid WORKER_FINDING_CONFIDENCE_THRESHOLD value");
  });

  it("rejects retry delay below minimum", () => {
    process.env["WORKER_GITHUB_RETRY_DELAY_MS"] = "5";
    expect(() => loadConfig()).toThrow("Invalid WORKER_GITHUB_RETRY_DELAY_MS value");
  });
});

describe("resolveGitHubFetchOptions", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the GitHub-specific subset of worker config", () => {
    delete process.env["WORKER_POLL_INTERVAL_MS"];
    delete process.env["WORKER_MAX_PROCESSED_KEYS"];
    delete process.env["GITHUB_API_BASE_URL"];
    delete process.env["WORKER_GITHUB_USER_AGENT"];
    delete process.env["WORKER_GITHUB_REQUEST_TIMEOUT_MS"];
    delete process.env["WORKER_GITHUB_FETCH_RETRIES"];
    delete process.env["WORKER_GITHUB_RETRY_DELAY_MS"];
    delete process.env["WORKER_FINDING_CONFIDENCE_THRESHOLD"];
    delete process.env["WORKER_FINDING_MAX_COMMENTS"];
    delete process.env["WORKER_FINDING_TEST_FILE_CONFIDENCE_THRESHOLD"];

    const options = resolveGitHubFetchOptions();

    expect(options.githubApiBaseUrl).toBe("https://api.github.com");
    expect(options.githubUserAgent).toBe("mergewise-worker");
    expect(options.githubRequestTimeoutMs).toBe(10000);
    expect(options.githubFetchRetries).toBe(2);
    expect(options.githubRetryDelayMs).toBe(250);
  });
});
