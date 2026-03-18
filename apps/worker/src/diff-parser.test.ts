import { describe, expect, test } from "bun:test";
import {
  toInstallationId,
  toPRNumber,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";
import type { AnalyzePullRequestJob } from "@mergewise/shared-types";

import { buildAnalysisContext } from "./diff-parser";

describe("buildAnalysisContext", () => {
  const baseJob: AnalyzePullRequestJob = {
    job_id: "00000000-0000-0000-0000-000000000001" as AnalyzePullRequestJob["job_id"],
    installation_id: toInstallationId(42),
    repo_full_name: toRepoFullName("acme/widget"),
    pr_number: toPRNumber(7),
    head_sha: toSHA("a".repeat(40)),
    queued_at: "2026-01-01T00:00:00.000Z",
  };

  test("threads pr_title and pr_body into pullRequest metadata", () => {
    const job: AnalyzePullRequestJob = {
      ...baseJob,
      pr_title: "fix: replace streams with sync reads",
      pr_body: "Streams hang in Bun.",
    };
    const context = buildAnalysisContext(job, []);
    expect(context.pullRequest.prTitle).toBe("fix: replace streams with sync reads");
    expect(context.pullRequest.prDescription).toBe("Streams hang in Bun.");
  });

  test("omits prTitle and prDescription for legacy jobs without them", () => {
    const context = buildAnalysisContext(baseJob, []);
    expect(context.pullRequest.prTitle).toBeUndefined();
    expect(context.pullRequest.prDescription).toBeUndefined();
  });
});
