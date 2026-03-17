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
 * Discriminated union of all queue job types.
 */
export type QueueJob = AnalyzePullRequestJob | CollectFeedbackJob;
