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
  /**
   * Pull request title.
   */
  title?: string;
  /**
   * Pull request body (description). May be null when unset by the author.
   */
  body?: string | null;
}

/**
 * Extended repository shape that includes the default branch name.
 */
export interface GitHubRepositoryWithDefaultBranch extends GitHubRepository {
  /**
   * Default branch name (e.g. `main`, `master`).
   */
  default_branch: string;
}

/**
 * Minimal `push` webhook payload shape consumed by Mergewise.
 *
 * Models only the fields required for default-branch indexing.
 */
export interface GitHubPushWebhookEvent {
  /**
   * Full git ref that was pushed (e.g. `refs/heads/main`).
   */
  ref: string;
  /**
   * SHA of the most recent commit on the ref after the push.
   */
  after: string;
  /**
   * Repository metadata including default branch.
   */
  repository: GitHubRepositoryWithDefaultBranch;
  /**
   * Optional installation context for GitHub App events.
   *
   * GitHub sends `null` when no App installation is associated with the event.
   */
  installation?: {
    /**
     * GitHub App installation identifier.
     */
    id: number;
  } | null;
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
