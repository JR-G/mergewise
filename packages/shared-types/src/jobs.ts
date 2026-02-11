/**
 * Queue job payload for pull request analysis work.
 */
export interface AnalyzePullRequestJob {
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
   * ISO timestamp indicating when the job was queued.
   */
  queued_at: string;
}
