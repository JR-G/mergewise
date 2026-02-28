import type {
  AnalysisContext,
  AnalyzePullRequestJob,
  DiffHunk,
  FileDiff,
} from "@mergewise/shared-types";
import type { GitHubPullRequestFile } from "@mergewise/github-client";

/**
 * Builds rule-engine analysis context from fetched GitHub file metadata.
 *
 * @param job - Job payload.
 * @param fileDiffs - Parsed file diffs for the pull request.
 * @returns Rule-engine analysis context.
 */
export function buildAnalysisContext(
  job: AnalyzePullRequestJob,
  fileDiffs: readonly FileDiff[],
): AnalysisContext {
  return {
    diffs: fileDiffs,
    pullRequest: {
      repo: job.repo_full_name,
      prNumber: job.pr_number,
      headSha: job.head_sha,
      installationId: job.installation_id,
    },
  };
}

/**
 * Converts raw GitHub pull request file payloads into the internal {@link FileDiff} format.
 *
 * @param githubFiles - Files returned by the GitHub pull request files endpoint.
 * @returns Mapped file diffs with parsed hunks.
 */
export function mapGitHubPullRequestFilesToDiffs(
  githubFiles: readonly GitHubPullRequestFile[],
): readonly FileDiff[] {
  return githubFiles.map((githubFile) => ({
    filePath: githubFile.filename,
    previousPath: null,
    hunks: parsePatchToDiffHunks(githubFile.patch),
  }));
}

/**
 * Parses a unified diff patch string into structured hunk objects.
 *
 * @param patch - Raw unified diff patch text from GitHub.
 * @returns Parsed diff hunks with header and line content.
 */
export function parsePatchToDiffHunks(patch: string | undefined): readonly DiffHunk[] {
  if (!patch) {
    return [];
  }

  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let currentHeader: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const isHunkHeader = line.startsWith("@@");
    const shouldAppendCurrentLine = !isHunkHeader && currentHeader !== null;
    if (shouldAppendCurrentLine) {
      currentLines.push(line);
    }
    if (!isHunkHeader) {
      continue;
    }

    if (currentHeader !== null) {
      hunks.push({ header: currentHeader, lines: currentLines });
    }
    currentHeader = line;
    currentLines = [];
  }

  if (currentHeader !== null) {
    hunks.push({ header: currentHeader, lines: currentLines });
  }

  return hunks;
}
