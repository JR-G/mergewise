import type {
  InstallationId,
  JobId,
  PRNumber,
  RepoFullName,
  SHA,
} from "./branded";

/**
 * Queue job payload for pull request analysis work.
 */
export interface AnalyzePullRequestJob {
  /**
   * Job type discriminator. Absent on legacy queue entries.
   */
  type?: "analyze-pull-request" | undefined;
  /**
   * Stable unique identifier for this queue item.
   */
  job_id: JobId;
  /**
   * GitHub App installation id for API token resolution.
   */
  installation_id: InstallationId | null;
  /**
   * Repository full name in `owner/name` format.
   */
  repo_full_name: RepoFullName;
  /**
   * Pull request number in the repository.
   */
  pr_number: PRNumber;
  /**
   * Pull request head commit SHA associated with this job.
   */
  head_sha: SHA;
  /**
   * Optional end-to-end trace identifier propagated from webhook intake.
   */
  trace_id?: string | undefined;
  /**
   * ISO timestamp indicating when the job was queued.
   */
  queued_at: string;
  /**
   * GitHub check run identifier created at webhook intake for early PR status visibility.
   */
  check_run_id?: number | undefined;
  /**
   * Pull request title from the webhook payload. Absent on legacy queued jobs.
   */
  pr_title?: string | undefined;
  /**
   * Pull request body from the webhook payload, capped at 1000 characters.
   * Absent on legacy queued jobs.
   */
  pr_body?: string | undefined;
}

/**
 * Queue job payload for collecting feedback reactions on PR close/merge.
 */
export interface CollectFeedbackJob {
  /**
   * Job type discriminator.
   */
  type: "collect-feedback";
  /**
   * Stable unique identifier for this queue item.
   */
  job_id: JobId;
  /**
   * GitHub App installation id for API token resolution.
   */
  installation_id: InstallationId | null;
  /**
   * Repository full name in `owner/name` format.
   */
  repo_full_name: RepoFullName;
  /**
   * Pull request number in the repository.
   */
  pr_number: PRNumber;
  /**
   * Optional end-to-end trace identifier propagated from webhook intake.
   */
  trace_id?: string | undefined;
  /**
   * ISO timestamp indicating when the job was queued.
   */
  queued_at: string;
}

/**
 * Queue job payload for indexing a repository's dependency graph and debt profile.
 */
export interface IndexRepoJob {
  /**
   * Job type discriminator.
   */
  type: "index-repo";
  /**
   * Stable unique identifier for this queue item.
   */
  job_id: string;
  /**
   * GitHub App installation id for API token resolution.
   */
  installation_id: number | null;
  /**
   * Repository full name in `owner/name` format.
   */
  repo_full_name: string;
  /**
   * Default branch name for the repository (e.g. `main`).
   */
  default_branch: string;
  /**
   * Head commit SHA on the default branch at the time of the push.
   */
  head_sha: string;
  /**
   * Optional end-to-end trace identifier propagated from webhook intake.
   */
  trace_id?: string;
  /**
   * ISO timestamp indicating when the job was queued.
   */
  queued_at: string;
}

/**
 * Discriminated union of all queue job types.
 */
export type QueueJob = AnalyzePullRequestJob | CollectFeedbackJob | IndexRepoJob;
