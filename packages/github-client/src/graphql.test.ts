import { describe, expect, test } from "bun:test";

import { listPullRequestReviewThreadsWithReplies } from "./index";

describe("paginateGraphqlQuery validation", () => {
  test("rejects non-integer perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: 1.5,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects NaN perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: NaN,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects negative maxPages", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      maxPages: -1,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects zero maxPages", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      maxPages: 0,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });

  test("rejects Infinity perPage", () => {
    const promise = listPullRequestReviewThreadsWithReplies({
      owner: "acme",
      repository: "widget",
      pullRequestNumber: 1,
      installationAccessToken: "ghs_token",
      perPage: Infinity,
    });
    expect(promise).rejects.toBeInstanceOf(RangeError);
  });
});
