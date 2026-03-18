import {
  buildAnalyzePullRequestJob,
  buildCollectFeedbackJob,
  buildIndexRepoJob,
} from "@mergewise/webhook-api";
import {
  enqueueAnalyzePullRequestJob,
  enqueueCollectFeedbackJob,
  enqueueIndexRepoJob,
  readAllQueueJobs,
} from "@mergewise/job-store";
import type {
  AnalyzePullRequestJob,
  CollectFeedbackJob,
  GitHubPullRequestWebhookEvent,
  GitHubPushWebhookEvent,
  IndexRepoJob,
  QueueJob,
} from "@mergewise/shared-types";
import {
  toInstallationId,
  toPRNumber,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";

const TEST_SHA = toSHA("a".repeat(40));
const TEST_REPO = toRepoFullName("test-org/test-repo");
const TEST_INSTALLATION_ID = toInstallationId(99);
const TEST_PR_NUMBER = toPRNumber(42);

/**
 * Builds a valid GitHub pull_request webhook payload for testing.
 *
 * @param action - The pull request action (opened, synchronize, closed, etc.).
 * @param overrides - Optional partial overrides for the payload fields.
 * @returns A complete webhook payload matching the GitHubPullRequestWebhookEvent shape.
 */
interface BuildTestPrPayloadOverrides {
  readonly repoFullName?: ReturnType<typeof toRepoFullName>;
  readonly prNumber?: ReturnType<typeof toPRNumber>;
  readonly headSha?: ReturnType<typeof toSHA>;
  readonly installationId?: ReturnType<typeof toInstallationId>;
  readonly draft?: boolean;
  readonly state?: "open" | "closed";
  readonly merged?: boolean;
  readonly prTitle?: string;
  readonly prBody?: string;
}

export function buildTestPrPayload(
  action: string,
  overrides: BuildTestPrPayloadOverrides = {},
): GitHubPullRequestWebhookEvent {
  return {
    action,
    repository: {
      full_name: overrides.repoFullName ?? TEST_REPO,
    },
    pull_request: {
      number: overrides.prNumber ?? TEST_PR_NUMBER,
      head: {
        sha: overrides.headSha ?? TEST_SHA,
      },
      draft: overrides.draft ?? false,
      state: overrides.state ?? "open",
      merged: overrides.merged ?? false,
      title: overrides.prTitle ?? "Test pull request",
      body: overrides.prBody ?? "Test PR body",
    },
    installation: {
      id: overrides.installationId ?? TEST_INSTALLATION_ID,
    },
  };
}

interface BuildTestPushPayloadOverrides {
  readonly repoFullName?: ReturnType<typeof toRepoFullName>;
  readonly headSha?: ReturnType<typeof toSHA>;
  readonly defaultBranch?: string;
  readonly ref?: string;
  readonly installationId?: ReturnType<typeof toInstallationId>;
}

/**
 * Builds a valid GitHub push webhook payload targeting the default branch.
 *
 * @param overrides - Optional partial overrides for the payload fields.
 * @returns A complete push webhook payload.
 */
export function buildTestPushPayload(
  overrides: BuildTestPushPayloadOverrides = {},
): GitHubPushWebhookEvent {
  const defaultBranch = overrides.defaultBranch ?? "main";
  return {
    ref: overrides.ref ?? `refs/heads/${defaultBranch}`,
    after: overrides.headSha ?? TEST_SHA,
    repository: {
      full_name: overrides.repoFullName ?? TEST_REPO,
      default_branch: defaultBranch,
    },
    installation: {
      id: overrides.installationId ?? TEST_INSTALLATION_ID,
    },
  };
}

/**
 * Simulates a pull_request.opened webhook by building a job and writing it
 * to the real NDJSON job store at the specified path.
 *
 * @param payload - The webhook payload.
 * @param jobFilePath - Temp file path for the job store.
 * @param traceId - Optional trace ID for the job.
 * @returns The enqueued job.
 */
export function simulatePrWebhook(
  payload: GitHubPullRequestWebhookEvent,
  jobFilePath: string,
  traceId?: string,
): AnalyzePullRequestJob {
  const job = buildAnalyzePullRequestJob(payload, traceId);
  enqueueAnalyzePullRequestJob(job, jobFilePath);
  return job;
}

/**
 * Simulates a push webhook by building an index job and writing it
 * to the real NDJSON job store.
 *
 * @param payload - The push webhook payload.
 * @param jobFilePath - Temp file path for the job store.
 * @param traceId - Optional trace ID for the job.
 * @returns The enqueued job.
 */
export function simulatePushWebhook(
  payload: GitHubPushWebhookEvent,
  jobFilePath: string,
  traceId?: string,
): IndexRepoJob {
  const job = buildIndexRepoJob(payload, traceId);
  enqueueIndexRepoJob(job, jobFilePath);
  return job;
}

/**
 * Simulates a pull_request.closed webhook by building a feedback job
 * and writing it to the real NDJSON job store.
 *
 * @param payload - The closed PR webhook payload.
 * @param jobFilePath - Temp file path for the job store.
 * @param traceId - Optional trace ID for the job.
 * @returns The enqueued job.
 */
export function simulateClosedPrWebhook(
  payload: GitHubPullRequestWebhookEvent,
  jobFilePath: string,
  traceId?: string,
): CollectFeedbackJob {
  const job = buildCollectFeedbackJob(payload, traceId);
  enqueueCollectFeedbackJob(job, jobFilePath);
  return job;
}

/**
 * Reads all jobs from a temp NDJSON file, exercising the real deserialisation path.
 *
 * @param jobFilePath - Path to the NDJSON file.
 * @returns Array of deserialised queue jobs.
 */
export function readJobsFromFile(jobFilePath: string): QueueJob[] {
  const { jobs } = readAllQueueJobs(jobFilePath);
  return jobs;
}
