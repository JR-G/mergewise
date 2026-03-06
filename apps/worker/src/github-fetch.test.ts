import { describe, expect, it } from "bun:test";

import { GitHubApiError } from "@mergewise/github-client";

import {
  fetchPullRequestFilesWithRetry,
  isRetryablePullRequestFileFetchError,
} from "./github-fetch";

describe("isRetryablePullRequestFileFetchError", () => {
  it("returns true for 429 rate-limit errors", () => {
    const error = new GitHubApiError(429, "GET", "https://api.github.com/x", "rate limited");
    expect(isRetryablePullRequestFileFetchError(error)).toBe(true);
  });

  it("returns true for 500+ server errors", () => {
    const error = new GitHubApiError(502, "GET", "https://api.github.com/x", "bad gateway");
    expect(isRetryablePullRequestFileFetchError(error)).toBe(true);
  });

  it("returns false for 404 client errors", () => {
    const error = new GitHubApiError(404, "GET", "https://api.github.com/x", "not found");
    expect(isRetryablePullRequestFileFetchError(error)).toBe(false);
  });

  it("returns true for TypeError (network failures)", () => {
    expect(isRetryablePullRequestFileFetchError(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns false for generic Error", () => {
    expect(isRetryablePullRequestFileFetchError(new Error("something broke"))).toBe(false);
  });
});

describe("fetchPullRequestFilesWithRetry", () => {
  const baseOptions = {
    owner: "acme",
    repository: "widget",
    pullRequestNumber: 10,
    installationAccessToken: "tok",
  };

  it("returns files on first attempt when fetch succeeds", async () => {
    const files = await fetchPullRequestFilesWithRetry(
      baseOptions,
      2,
      5,
      {
        fetchPullRequestFiles: async () => [
          { filename: "src/app.ts", status: "modified", additions: 1, deletions: 0, changes: 1 },
        ],
        sleep: async () => {},
      },
    );

    expect(files.some((file) => file.filename === "src/app.ts")).toBe(true);
  });

  it("exhausts all retries then throws for persistent retryable failures", async () => {
    let attemptCount = 0;

    try {
      await fetchPullRequestFilesWithRetry(
        baseOptions,
        1,
        5,
        {
          fetchPullRequestFiles: async () => {
            attemptCount += 1;
            throw new GitHubApiError(503, "GET", "https://api.github.com/x", "down");
          },
          sleep: async () => {},
        },
      );
      expect.unreachable("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(GitHubApiError);
    }

    expect(attemptCount).toBe(2);
  });

  it("passes the configured delay to the sleep function between retries", async () => {
    const sleepDelays: number[] = [];

    try {
      await fetchPullRequestFilesWithRetry(
        baseOptions,
        2,
        42,
        {
          fetchPullRequestFiles: async () => {
            throw new GitHubApiError(500, "GET", "https://api.github.com/x", "error");
          },
          sleep: async (delayMs) => {
            sleepDelays.push(delayMs);
          },
        },
      );
      expect.unreachable("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(GitHubApiError);
    }

    expect(sleepDelays.every((delay) => delay === 42)).toBe(true);
  });

  it("succeeds without retrying when maxRetries is zero", async () => {
    const files = await fetchPullRequestFilesWithRetry(
      baseOptions,
      0,
      5,
      {
        fetchPullRequestFiles: async () => [
          { filename: "readme.md", status: "added", additions: 5, deletions: 0, changes: 5 },
        ],
        sleep: async () => {},
      },
    );

    expect(files.some((file) => file.filename === "readme.md")).toBe(true);
  });
});
