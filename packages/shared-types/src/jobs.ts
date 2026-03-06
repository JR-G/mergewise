/**
 * Queue job payload for pull request analysis work.
 */
export interface AnalyzePullRequestJob {
  /**
   * Job type discriminator. Absent on legacy queue entries.
   */
  type?: "analyze-pull-request";
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
   * Pull request number in the repository.
   */
  pr_number: number;
  /**
   * Pull request head commit SHA associated with this job.
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
  /**
   * GitHub check run identifier created at webhook intake for early PR status visibility.
   */
  check_run_id?: number;
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
   * Pull request number in the repository.
   */
  pr_number: number;
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
export type QueueJob = AnalyzePullRequestJob | CollectFeedbackJob;
