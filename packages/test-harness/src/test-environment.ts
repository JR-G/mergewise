import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, type DebtStore } from "@mergewise/debt-scanner";
import { openFeedbackStore, type FeedbackStore } from "@mergewise/feedback-store";
import type {
  CreateCheckRunOptions,
  CreatePullRequestReviewOptions,
  FetchPullRequestOptions,
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestFile,
  GitHubPullRequestReview,
  ListPullRequestCommentsOptions,
  ListPullRequestReviewThreadsOptions,
  PostPullRequestSummaryCommentOptions,
  ResolveReviewThreadOptions,
  ResolveReviewThreadResult,
  ReviewThread,
  UpdateCheckRunOptions,
  UpdateIssueCommentOptions,
} from "@mergewise/github-client";
import type { WorkerProcessingDependencies } from "@mergewise/worker";

/**
 * A single recorded call to a GitHub stub function.
 */
export interface RecordedCall<TOptions = unknown, TResult = unknown> {
  readonly options: TOptions;
  readonly result: TResult;
}

/**
 * Captured calls from GitHub stub functions, keyed by operation name.
 */
export interface RecordedGitHubCalls {
  readonly createCheckRun: RecordedCall<CreateCheckRunOptions, GitHubCheckRun>[];
  readonly updateCheckRun: RecordedCall<UpdateCheckRunOptions, GitHubCheckRun>[];
  readonly createPullRequestReview: RecordedCall<CreatePullRequestReviewOptions, GitHubPullRequestReview>[];
  readonly fetchPullRequest: RecordedCall<FetchPullRequestOptions, GitHubPullRequest>[];
  readonly postPullRequestSummaryComment: RecordedCall<PostPullRequestSummaryCommentOptions, GitHubIssueComment>[];
  readonly updateIssueComment: RecordedCall<UpdateIssueCommentOptions, GitHubIssueComment>[];
  readonly listPullRequestSummaryComments: RecordedCall<ListPullRequestCommentsOptions, GitHubIssueComment[]>[];
  readonly listPullRequestReviewThreads: RecordedCall<ListPullRequestReviewThreadsOptions, ReviewThread[]>[];
  readonly resolveReviewThread: RecordedCall<ResolveReviewThreadOptions, ResolveReviewThreadResult>[];
}

/**
 * GitHub API stubs that record all calls for assertion.
 */
export interface GitHubStubs {
  readonly recorded: RecordedGitHubCalls;
  readonly prFiles: GitHubPullRequestFile[];
  readonly prState: GitHubPullRequest;
  readonly summaryComments: GitHubIssueComment[];
  readonly reviewThreads: ReviewThread[];
  readonly deps: Pick<
    WorkerProcessingDependencies,
    | "createGitHubAppJwtFn"
    | "exchangeInstallationAccessTokenFn"
    | "fetchPullRequestFilesWithRetryFn"
    | "fetchPullRequestFn"
    | "createCheckRunFn"
    | "updateCheckRunFn"
    | "createPullRequestReviewFn"
    | "postPullRequestSummaryCommentFn"
    | "updateIssueCommentFn"
    | "listPullRequestSummaryCommentsFn"
    | "listPullRequestReviewThreadsFn"
    | "resolveReviewThreadFn"
  >;
}

/**
 * Configuration for creating GitHub stubs with custom return values.
 */
export interface GitHubStubsConfig {
  readonly prFiles?: GitHubPullRequestFile[];
  readonly prState?: GitHubPullRequest;
  readonly summaryComments?: GitHubIssueComment[];
  readonly reviewThreads?: ReviewThread[];
}

const DEFAULT_PR_STATE: GitHubPullRequest = {
  number: 50,
  state: "open",
  merged: false,
  title: "Test PR",
};

let nextCheckRunId = 1000;

/**
 * Creates GitHub API stubs that record all invocations for test assertions.
 *
 * @param config - Optional overrides for default return values.
 * @returns Stubs object with recorded calls and DI-compatible dependency fields.
 */
export function createGitHubStubs(config: GitHubStubsConfig = {}): GitHubStubs {
  const prFiles = config.prFiles ?? [];
  const prState = config.prState ?? DEFAULT_PR_STATE;
  const summaryComments = config.summaryComments ?? [];
  const reviewThreads = config.reviewThreads ?? [];

  const recorded: RecordedGitHubCalls = {
    createCheckRun: [],
    updateCheckRun: [],
    createPullRequestReview: [],
    fetchPullRequest: [],
    postPullRequestSummaryComment: [],
    updateIssueComment: [],
    listPullRequestSummaryComments: [],
    listPullRequestReviewThreads: [],
    resolveReviewThread: [],
  };

  const deps: GitHubStubs["deps"] = {
    createGitHubAppJwtFn: () => "test-jwt",
    exchangeInstallationAccessTokenFn: (() =>
      Promise.resolve({
        token: "test-installation-token",
        expires_at: "2099-01-01T00:00:00Z",
      })) as WorkerProcessingDependencies["exchangeInstallationAccessTokenFn"],
    fetchPullRequestFilesWithRetryFn: () => Promise.resolve(prFiles),
    fetchPullRequestFn: ((options: FetchPullRequestOptions) => {
      const result = prState;
      recorded.fetchPullRequest.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["fetchPullRequestFn"],
    createCheckRunFn: ((options: CreateCheckRunOptions) => {
      const thisId = nextCheckRunId;
      nextCheckRunId += 1;
      const result: GitHubCheckRun = { id: thisId } as GitHubCheckRun;
      recorded.createCheckRun.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["createCheckRunFn"],
    updateCheckRunFn: ((options: UpdateCheckRunOptions) => {
      const result: GitHubCheckRun = { id: options.checkRunId } as GitHubCheckRun;
      recorded.updateCheckRun.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["updateCheckRunFn"],
    createPullRequestReviewFn: ((options: CreatePullRequestReviewOptions) => {
      const result: GitHubPullRequestReview = { id: 1 } as GitHubPullRequestReview;
      recorded.createPullRequestReview.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["createPullRequestReviewFn"],
    postPullRequestSummaryCommentFn: ((options: PostPullRequestSummaryCommentOptions) => {
      const result: GitHubIssueComment = { id: 1, body: options.body } as GitHubIssueComment;
      recorded.postPullRequestSummaryComment.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["postPullRequestSummaryCommentFn"],
    updateIssueCommentFn: ((options: UpdateIssueCommentOptions) => {
      const result: GitHubIssueComment = { id: options.commentId, body: options.body } as GitHubIssueComment;
      recorded.updateIssueComment.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["updateIssueCommentFn"],
    listPullRequestSummaryCommentsFn: ((options: ListPullRequestCommentsOptions) => {
      recorded.listPullRequestSummaryComments.push({ options, result: summaryComments });
      return Promise.resolve(summaryComments);
    }) as WorkerProcessingDependencies["listPullRequestSummaryCommentsFn"],
    listPullRequestReviewThreadsFn: ((options: ListPullRequestReviewThreadsOptions) => {
      recorded.listPullRequestReviewThreads.push({ options, result: reviewThreads });
      return Promise.resolve(reviewThreads);
    }) as WorkerProcessingDependencies["listPullRequestReviewThreadsFn"],
    resolveReviewThreadFn: ((options: ResolveReviewThreadOptions) => {
      const result: ResolveReviewThreadResult = { isResolved: true };
      recorded.resolveReviewThread.push({ options, result });
      return Promise.resolve(result);
    }) as WorkerProcessingDependencies["resolveReviewThreadFn"],
  };

  return { recorded, prFiles, prState, summaryComments, reviewThreads, deps };
}

/**
 * A fully wired integration test environment with temp directories,
 * real SQLite stores, and GitHub stubs.
 */
export interface TestEnvironment {
  readonly tempDir: string;
  readonly jobFilePath: string;
  readonly offsetFilePath: string;
  readonly debtStore: DebtStore;
  readonly feedbackStore: FeedbackStore;
  readonly githubStubs: GitHubStubs;
  readonly capturedLogs: string[];
  readonly capturedErrors: string[];
  readonly capturedWarnings: string[];
  readonly logInfo: (message: string) => void;
  readonly logError: (message: string) => void;
  readonly logWarn: (message: string) => void;
  readonly cleanup: () => void;
}

/**
 * Creates a fully isolated test environment with temp files, real SQLite stores,
 * and recording GitHub stubs.
 *
 * @param githubConfig - Optional overrides for GitHub stub return values.
 * @returns Test environment with cleanup function.
 */
export function createTestEnvironment(
  githubConfig: GitHubStubsConfig = {},
): TestEnvironment {
  const tempDir = mkdtempSync(join(tmpdir(), "mergewise-integration-"));
  const jobFilePath = join(tempDir, "jobs.ndjson");
  const offsetFilePath = join(tempDir, "jobs.offset");
  const debtDbPath = join(tempDir, "debt.db");
  const feedbackDbPath = join(tempDir, "feedback.db");

  const debtStore = openStore(debtDbPath);
  const feedbackStore = openFeedbackStore(feedbackDbPath);
  const githubStubs = createGitHubStubs(githubConfig);

  const capturedLogs: string[] = [];
  const capturedErrors: string[] = [];
  const capturedWarnings: string[] = [];
  const logInfo = (message: string): void => {
    capturedLogs.push(message);
  };
  const logError = (message: string): void => {
    capturedErrors.push(message);
  };
  const logWarn = (message: string): void => {
    capturedWarnings.push(message);
  };

  const cleanup = (): void => {
    try {
      debtStore.close();
    } catch { /* already closed */ }
    try {
      feedbackStore.close();
    } catch { /* already closed */ }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  };

  return {
    tempDir,
    jobFilePath,
    offsetFilePath,
    debtStore,
    feedbackStore,
    githubStubs,
    capturedLogs,
    capturedErrors,
    capturedWarnings,
    logInfo,
    logError,
    logWarn,
    cleanup,
  };
}
