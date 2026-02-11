/**
 * Pull request actions that should trigger a fresh analysis run.
 */
export type GitHubPullRequestAction = "opened" | "reopened" | "synchronize";

/**
 * Minimal repository shape used by Mergewise webhook handling.
 */
export interface GitHubRepository {
  /**
   * Repository full name in `owner/name` format.
   */
  full_name: string;
}

/**
 * Minimal pull request shape used by Mergewise webhook handling.
 */
export interface GitHubPullRequest {
  /**
   * Pull request number in the target repository.
   */
  number: number;
  /**
   * Pull request head metadata.
   */
  head: {
    /**
     * Head commit SHA for idempotent analysis keys.
     */
    sha: string;
  };
}

/**
 * Minimal `pull_request` webhook payload shape consumed by Mergewise.
 *
 * This intentionally models only the fields required by the current
 * intake pipeline so parsing remains strict and easy to reason about.
 */
export interface GitHubPullRequestWebhookEvent {
  /**
   * GitHub action type for the pull request event.
   */
  action: string;
  /**
   * Repository metadata.
   */
  repository: GitHubRepository;
  /**
   * Pull request metadata.
   */
  pull_request: GitHubPullRequest;
  /**
   * Optional installation context for GitHub App events.
   */
  installation?: {
    /**
     * GitHub App installation identifier.
     */
    id: number;
  };
}
