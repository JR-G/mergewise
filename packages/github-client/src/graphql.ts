import {
  type GitHubApiOptions,
  buildHeaders,
  trimTrailingSlash,
  resolveRequestTimeoutMs,
  parseGraphQlResponse,
} from "./http";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface PaginatedPage<T> {
  readonly threads: T[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

async function paginateGraphqlQuery<T>(
  options: ListPullRequestReviewThreadsOptions,
  queryString: string,
  pageExtractor: (data: unknown) => PaginatedPage<T>,
): Promise<T[]> {
  const perPage = clamp(options.perPage ?? 100, 1, 100);
  const maxPages = clamp(options.maxPages ?? 20, 1, 50);
  const maxTotalThreads = perPage * maxPages;
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl = `${apiBaseUrl}/graphql`;
  const collected: T[] = [];
  let cursor: string | null = null;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const variables: Record<string, unknown> = {
      owner: options.owner,
      name: options.repository,
      prNumber: options.pullRequestNumber,
      first: perPage,
    };
    if (cursor !== null) {
      variables.after = cursor;
    }

    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: buildHeaders({
        authorization: `Bearer ${options.installationAccessToken}`,
        userAgent: options.userAgent,
        contentType: "application/json",
        traceId: options.traceId,
      }),
      body: JSON.stringify({ query: queryString, variables }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    const page = await parseGraphQlResponse<PaginatedPage<T>>(response, endpointUrl, pageExtractor);
    collected.push(...page.threads);
    if (collected.length >= maxTotalThreads) {
      break;
    }
    if (!page.hasNextPage || page.endCursor === null) {
      break;
    }
    cursor = page.endCursor;
  }

  return collected;
}

/**
 * Request options for minimising a comment via the GitHub GraphQL API.
 */
export interface MinimizeCommentOptions extends GitHubApiOptions {
  /**
   * Global node identifier of the comment to minimise.
   */
  subjectId: string;
  /**
   * Classification reason for minimising the comment.
   */
  classifier:
    | "OUTDATED"
    | "OFF_TOPIC"
    | "SPAM"
    | "RESOLVED"
    | "DUPLICATE"
    | "ABUSE";
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
}

/**
 * Response payload from the `minimizeComment` GraphQL mutation.
 */
export interface MinimizeCommentResult {
  /**
   * Whether the comment was successfully minimised.
   */
  readonly isMinimized: boolean;
}

/**
 * Review thread data returned by the GitHub GraphQL reviewThreads query.
 */
export interface ReviewThread {
  /**
   * Thread's global GraphQL node identifier (used for resolveReviewThread mutation).
   */
  readonly id: string;
  /**
   * Whether this thread has already been resolved.
   */
  readonly isResolved: boolean;
  /**
   * Whether GitHub considers the thread outdated (anchored code has changed).
   */
  readonly isOutdated: boolean;
  /**
   * Body text of the first comment in the thread.
   */
  readonly firstCommentBody: string;
}

/**
 * Request options for listing review threads on a pull request via GraphQL.
 */
export interface ListPullRequestReviewThreadsOptions extends GitHubApiOptions {
  /**
   * Repository owner.
   */
  owner: string;
  /**
   * Repository name.
   */
  repository: string;
  /**
   * Pull request number.
   */
  pullRequestNumber: number;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
  /**
   * Maximum threads to fetch per GraphQL page.
   *
   * @defaultValue `100`
   */
  perPage?: number;
  /**
   * Maximum number of pages to fetch.
   *
   * @defaultValue `20`
   */
  maxPages?: number;
}

/**
 * A single comment within a review thread, including author metadata.
 */
export interface ReviewThreadComment {
  readonly body: string;
  readonly authorLogin: string;
  readonly authorIsBot: boolean;
}

/**
 * Review thread data with up to 20 replies per thread for feedback extraction.
 *
 * @remarks
 * The underlying GraphQL query fetches `comments(first: 20)` per thread,
 * so threads with more than 20 replies will have their oldest replies truncated.
 */
export interface ReviewThreadWithReplies {
  readonly id: string;
  readonly firstCommentBody: string;
  readonly comments: readonly ReviewThreadComment[];
}

/**
 * Request options for resolving a review thread via GraphQL.
 */
export interface ResolveReviewThreadOptions extends GitHubApiOptions {
  /**
   * Global node identifier of the review thread to resolve.
   */
  threadId: string;
  /**
   * Installation access token used for API authentication.
   */
  installationAccessToken: string;
}

/**
 * Response payload from the `resolveReviewThread` GraphQL mutation.
 */
export interface ResolveReviewThreadResult {
  /**
   * Whether the thread is now resolved.
   */
  readonly isResolved: boolean;
}

/**
 * Minimises a comment via the GitHub GraphQL `minimizeComment` mutation.
 *
 * @param options - Minimise comment request options.
 * @returns Minimisation result.
 * @throws {@link GitHubApiError} when the HTTP request itself fails.
 * @throws {@link GitHubGraphQlError} when the GraphQL response contains errors.
 */
export async function minimizeComment(
  options: MinimizeCommentOptions,
): Promise<MinimizeCommentResult> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl = `${apiBaseUrl}/graphql`;
  const query = `mutation($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
    minimizedComment { isMinimized }
  }
}`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify({
      query,
      variables: {
        subjectId: options.subjectId,
        classifier: options.classifier,
      },
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  return parseGraphQlResponse<MinimizeCommentResult>(
    response,
    endpointUrl,
    (data) => {
      const minimizedComment = (
        data as {
          minimizeComment?: { minimizedComment?: { isMinimized?: boolean } };
        }
      ).minimizeComment?.minimizedComment;
      return { isMinimized: minimizedComment?.isMinimized === true };
    },
  );
}

/**
 * Lists review threads on a pull request via the GitHub GraphQL API.
 *
 * @param options - Review thread listing options.
 * @returns Review threads in API order.
 * @throws {@link GitHubApiError} when the HTTP request fails.
 * @throws {@link GitHubGraphQlError} when the GraphQL response contains errors.
 */
export async function listPullRequestReviewThreads(
  options: ListPullRequestReviewThreadsOptions,
): Promise<ReviewThread[]> {
  return paginateGraphqlQuery(options, buildReviewThreadsQuery(), extractReviewThreadPage);
}

function buildReviewThreadsQuery(): string {
  return `query($owner: String!, $name: String!, $prNumber: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) { nodes { body } }
        }
      }
    }
  }
}`;
}

interface ReviewThreadPageResult {
  threads: ReviewThread[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function extractReviewThreadPage(data: unknown): ReviewThreadPageResult {
  const reviewThreads = (
    data as {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: {
              id?: string;
              isResolved?: boolean;
              isOutdated?: boolean;
              comments?: { nodes?: { body?: string }[] };
            }[];
          };
        };
      };
    }
  ).repository?.pullRequest?.reviewThreads;
  const nodes = reviewThreads?.nodes ?? [];
  const threads: ReviewThread[] = nodes.map((node) => ({
    id: node.id ?? "",
    isResolved: node.isResolved === true,
    isOutdated: node.isOutdated === true,
    firstCommentBody: node.comments?.nodes?.[0]?.body ?? "",
  }));
  return {
    threads,
    hasNextPage: reviewThreads?.pageInfo?.hasNextPage === true,
    endCursor: reviewThreads?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Lists review threads with all comments for feedback extraction.
 *
 * @remarks
 * Unlike {@link listPullRequestReviewThreads} which fetches only the first
 * comment per thread, this function fetches up to 20 comments per thread
 * with author metadata for conversational learning extraction.
 *
 * @param options - Review thread listing options.
 * @returns Review threads with up to 20 replies each.
 * @throws {@link GitHubApiError} when the HTTP request fails.
 * @throws {@link GitHubGraphQlError} when the GraphQL response contains errors.
 */
export async function listPullRequestReviewThreadsWithReplies(
  options: ListPullRequestReviewThreadsOptions,
): Promise<ReviewThreadWithReplies[]> {
  return paginateGraphqlQuery(options, buildReviewThreadsWithRepliesQuery(), extractReviewThreadWithRepliesPage);
}

function buildReviewThreadsWithRepliesQuery(): string {
  return `query($owner: String!, $name: String!, $prNumber: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) {
      reviewThreads(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          comments(first: 20) {
            nodes {
              body
              author {
                login
                ... on Bot { id }
              }
            }
          }
        }
      }
    }
  }
}`;
}

interface RawThreadCommentAuthor {
  login?: string;
  id?: string;
}

interface RawThreadComment {
  body?: string;
  author?: RawThreadCommentAuthor | null;
}

interface RawThreadWithRepliesNode {
  id?: string;
  comments?: { nodes?: RawThreadComment[] };
}

function mapRawComment(raw: RawThreadComment): ReviewThreadComment {
  return {
    body: raw.body ?? "",
    authorLogin: raw.author?.login ?? "",
    authorIsBot: raw.author?.id !== undefined,
  };
}

function extractReviewThreadWithRepliesPage(data: unknown): {
  threads: ReviewThreadWithReplies[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const reviewThreads = (
    data as {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: RawThreadWithRepliesNode[];
          };
        };
      };
    }
  ).repository?.pullRequest?.reviewThreads;
  const nodes = reviewThreads?.nodes ?? [];
  const threads: ReviewThreadWithReplies[] = nodes.map((node) => {
    const rawComments = node.comments?.nodes ?? [];
    const comments = rawComments.map(mapRawComment);
    return {
      id: node.id ?? "",
      firstCommentBody: comments[0]?.body ?? "",
      comments,
    };
  });
  return {
    threads,
    hasNextPage: reviewThreads?.pageInfo?.hasNextPage === true,
    endCursor: reviewThreads?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Resolves a review thread via the GitHub GraphQL `resolveReviewThread` mutation.
 *
 * @param options - Thread resolution options.
 * @returns Resolution result.
 * @throws {@link GitHubApiError} when the HTTP request fails.
 * @throws {@link GitHubGraphQlError} when the GraphQL response contains errors.
 */
export async function resolveReviewThread(
  options: ResolveReviewThreadOptions,
): Promise<ResolveReviewThreadResult> {
  const requestTimeoutMs = resolveRequestTimeoutMs(options.requestTimeoutMs);
  const apiBaseUrl = trimTrailingSlash(
    options.apiBaseUrl ?? "https://api.github.com",
  );
  const endpointUrl = `${apiBaseUrl}/graphql`;
  const query = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}`;
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: buildHeaders({
      authorization: `Bearer ${options.installationAccessToken}`,
      userAgent: options.userAgent,
      contentType: "application/json",
      traceId: options.traceId,
    }),
    body: JSON.stringify({
      query,
      variables: { threadId: options.threadId },
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });

  return parseGraphQlResponse<ResolveReviewThreadResult>(
    response,
    endpointUrl,
    (data) => {
      const thread = (
        data as {
          resolveReviewThread?: { thread?: { isResolved?: boolean } };
        }
      ).resolveReviewThread?.thread;
      return { isResolved: thread?.isResolved === true };
    },
  );
}
