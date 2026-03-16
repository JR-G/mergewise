import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { CollectFeedbackJob, PRNumber, RepoFullName } from "@mergewise/shared-types";
import { toPRNumber } from "@mergewise/shared-types";
import type { FeedbackRecord, FeedbackStore, RepoInstruction } from "@mergewise/feedback-store";
import type { GitHubIssueComment, ReviewThreadWithReplies } from "@mergewise/github-client";

import { processCollectFeedbackJob, type FeedbackJobDependencies } from "./process-feedback-job";
import type { WorkerGitHubFetchOptions } from "./config";
import { createFeedbackJob } from "./test-helpers";

const originalEnv = { ...process.env };

beforeAll(() => {
  process.env["GITHUB_APP_ID"] = "12345";
  process.env["GITHUB_APP_PRIVATE_KEY"] = "fake-pem-key-for-tests";
});

afterAll(() => {
  if (originalEnv["GITHUB_APP_ID"] !== undefined) {
    process.env["GITHUB_APP_ID"] = originalEnv["GITHUB_APP_ID"];
  } else {
    delete process.env["GITHUB_APP_ID"];
  }

  if (originalEnv["GITHUB_APP_PRIVATE_KEY"] !== undefined) {
    process.env["GITHUB_APP_PRIVATE_KEY"] = originalEnv["GITHUB_APP_PRIVATE_KEY"];
  } else {
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
  }
});

function makeJob(overrides: Partial<CollectFeedbackJob> = {}): CollectFeedbackJob {
  return createFeedbackJob(overrides);
}

const DEFAULT_GITHUB_OPTIONS: WorkerGitHubFetchOptions = {
  githubApiBaseUrl: "https://api.github.com",
  githubUserAgent: "test-agent",
  githubRequestTimeoutMs: 5000,
  githubFetchRetries: 1,
  githubRetryDelayMs: 0,
};

function makeFeedbackStore(): FeedbackStore & {
  savedFeedback: FeedbackRecord[][];
  savedInstructions: RepoInstruction[][];
} {
  const savedFeedback: FeedbackRecord[][] = [];
  const savedInstructions: RepoInstruction[][] = [];
  return {
    savedFeedback,
    savedInstructions,
    saveFeedback(records) {
      savedFeedback.push([...records]);
    },
    saveInstructions(instructions) {
      savedInstructions.push([...instructions]);
    },
    queryInstructions() {
      return [];
    },
    queryRuleSentiment() {
      return [];
    },
    queryCategorySentiment() {
      return [];
    },
    close() {
      /* no-op */
    },
  };
}

function baseDependencies(
  overrides: Partial<FeedbackJobDependencies> = {},
): FeedbackJobDependencies {
  return {
    feedbackStore: makeFeedbackStore(),
    githubFetchOptions: DEFAULT_GITHUB_OPTIONS,
    createGitHubAppJwtFn: () => "jwt-token",
    exchangeInstallationAccessTokenFn: async () => ({ token: "ghs_test", expires_at: "" }),
    listPullRequestSummaryCommentsFn: async () => [],
    listPullRequestReviewThreadsWithRepliesFn: async () => [],
    logInfo: () => {},
    logError: () => {},
    ...overrides,
  };
}

describe("processCollectFeedbackJob", () => {
  test("skips processing when feedbackStore is unavailable", async () => {
    const logs: string[] = [];
    const { feedbackStore: _, ...withoutStore } = baseDependencies({
      logInfo: (message) => logs.push(message),
    });
    const dependencies = withoutStore;

    await processCollectFeedbackJob(makeJob(), dependencies);

    expect(logs.some((log) => log.includes("feedback_store_unavailable"))).toBe(true);
  });

  test("throws when installation_id is null", async () => {
    const errors: string[] = [];
    const dependencies = baseDependencies({
      logError: (message) => errors.push(message),
    });

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ installation_id: null }), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(errors.some((log) => log.includes("feedback_missing_installation"))).toBe(true);
  });

  test("throws when repo_full_name is invalid", async () => {
    const errors: string[] = [];
    const dependencies = baseDependencies({
      logError: (message) => errors.push(message),
    });

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ repo_full_name: "invalid" as unknown as RepoFullName }), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect(errors.some((log) => log.includes("invalid repo_full_name"))).toBe(true);
  });

  test("persists reaction feedback from summary comments", async () => {
    const store = makeFeedbackStore();
    const summaryComments: GitHubIssueComment[] = [
      {
        id: 1,
        node_id: "IC_1",
        html_url: "https://github.com/acme/widget/pull/10#issuecomment-1",
        body: "<!-- mergewise-meta dedupeKey=acme/widget#10:f1 findingId=f1 ruleId=clean/srp category=clean confidence=0.85 -->\nSome finding",
        reactions: { "+1": 2, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
      },
    ];

    const dependencies = baseDependencies({
      feedbackStore: store,
      listPullRequestSummaryCommentsFn: async () => summaryComments,
    });

    await processCollectFeedbackJob(makeJob(), dependencies);

    expect(store.savedFeedback.length).toBeGreaterThan(0);
    expect(store.savedFeedback[0]!.some((record) => record.findingId === "f1")).toBe(true);
  });

  test("persists instructions extracted from thread replies", async () => {
    const store = makeFeedbackStore();
    const threads: ReviewThreadWithReplies[] = [
      {
        id: "PRT_1",
        firstCommentBody: "<!-- mergewise-meta dedupeKey=acme/widget#10:f1 findingId=f1 ruleId=clean/srp category=clean confidence=0.85 -->",
        comments: [
          {
            body: "<!-- mergewise-meta dedupeKey=acme/widget#10:f1 findingId=f1 ruleId=clean/srp category=clean confidence=0.85 -->",
            authorLogin: "mergewise[bot]",
            authorIsBot: true,
          },
          {
            body: "skip SRP checks in test files",
            authorLogin: "alice",
            authorIsBot: false,
          },
        ],
      },
    ];

    const dependencies = baseDependencies({
      feedbackStore: store,
      listPullRequestReviewThreadsWithRepliesFn: async () => threads,
    });

    await processCollectFeedbackJob(makeJob(), dependencies);

    expect(store.savedInstructions.length).toBeGreaterThan(0);
    expect(store.savedInstructions[0]!.some((instruction) => instruction.instruction.includes("skip SRP"))).toBe(true);
  });

  test("rethrows auth failure after logging", async () => {
    const errors: string[] = [];
    const dependencies = baseDependencies({
      createGitHubAppJwtFn: () => {
        throw new Error("missing credentials");
      },
      logError: (message) => errors.push(message),
    });

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob(), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("missing credentials");
    expect(errors.some((log) => log.includes("feedback_auth_failed"))).toBe(true);
  });

  test("rethrows fetch failure after logging", async () => {
    const errors: string[] = [];
    const dependencies = baseDependencies({
      listPullRequestSummaryCommentsFn: async () => {
        throw new Error("network failure");
      },
      logError: (message) => errors.push(message),
    });

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob(), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("network failure");
    expect(errors.some((log) => log.includes("feedback_fetch_failed"))).toBe(true);
  });

  test("rethrows when feedback persistence fails", async () => {
    const failingStore = makeFeedbackStore();
    failingStore.saveFeedback = () => {
      throw new Error("disk full");
    };

    const summaryComments: GitHubIssueComment[] = [
      {
        id: 1,
        node_id: "IC_1",
        html_url: "https://github.com/acme/widget/pull/10#issuecomment-1",
        body: "<!-- mergewise-meta dedupeKey=acme/widget#10:f1 findingId=f1 ruleId=clean/srp category=clean confidence=0.85 -->\nFinding",
        reactions: { "+1": 1, "-1": 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
      },
    ];

    const dependencies = baseDependencies({
      feedbackStore: failingStore,
      listPullRequestSummaryCommentsFn: async () => summaryComments,
    });

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob(), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe("disk full");
  });

  test("propagates TypeError from extractInstructions when pr_number is zero", async () => {
    const dependencies = baseDependencies();

    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ pr_number: 0 as unknown as PRNumber }), dependencies);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(TypeError);
  });

  test("propagates TypeError for negative pr_number", async () => {
    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ pr_number: -1 as unknown as PRNumber }), baseDependencies());
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(TypeError);
  });

  test("propagates TypeError for NaN pr_number", async () => {
    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ pr_number: NaN as unknown as PRNumber }), baseDependencies());
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(TypeError);
  });

  test("propagates TypeError for non-integer pr_number", async () => {
    let thrownError: unknown;
    try {
      await processCollectFeedbackJob(makeJob({ pr_number: 3.14 as unknown as PRNumber }), baseDependencies());
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(TypeError);
  });

  test("succeeds with very large pr_number", async () => {
    const store = makeFeedbackStore();
    const dependencies = baseDependencies({ feedbackStore: store });

    await processCollectFeedbackJob(
      makeJob({ pr_number: toPRNumber(Number.MAX_SAFE_INTEGER) }),
      dependencies,
    );
  });
});
