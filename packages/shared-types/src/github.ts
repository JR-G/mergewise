import type {
  InstallationId,
  PRNumber,
  RepoFullName,
  SHA,
} from "./branded";

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
  full_name: RepoFullName;
}

/**
 * Minimal pull request shape used by Mergewise webhook handling.
 */
export interface GitHubPullRequest {
  /**
   * Pull request number in the target repository.
   */
  number: PRNumber;
  /**
   * Pull request head metadata.
   */
  head: {
    /**
     * Head commit SHA for idempotent analysis keys.
     */
    sha: SHA;
  };
  /**
   * Whether the pull request is a draft.
   */
  draft?: boolean;
  /**
   * Current pull request state (`open` or `closed`).
   */
  state?: "open" | "closed";
  /**
   * Whether the pull request has been merged.
   */
  merged?: boolean;
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
    id: InstallationId;
  };
}
