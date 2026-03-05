import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeedbackStore } from "./sqlite-store";
import { compileLearnings } from "./compile-learnings";
import type { FeedbackRecord, RepoInstruction } from "./types";

function tempDatabasePath(): string {
  return join(tmpdir(), `compile-test-${crypto.randomUUID()}.db`);
}

function buildRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    findingId: `finding-${crypto.randomUUID()}`,
    ruleId: "ts-react/no-any",
    category: "safety",
    confidence: "0.92",
    thumbsUp: 0,
    thumbsDown: 0,
    otherReactions: 0,
    repoFullName: "acme/widget",
    prNumber: 42,
    traceId: "trace-abc",
    recordedAt: "2026-03-03T12:00:00.000Z",
    ...overrides,
  };
}

function buildInstruction(overrides: Partial<RepoInstruction> = {}): RepoInstruction {
  return {
    repoFullName: "acme/widget",
    instruction: "prefer early returns",
    ruleId: "clean/srp",
    category: "clean",
    sourcePrNumber: 42,
    createdAt: "2026-03-03T12:00:00.000Z",
    ...overrides,
  };
}

const cleanupPaths: string[] = [];

function cleanup(): void {
  for (const filePath of cleanupPaths) {
    try { unlinkSync(filePath); } catch { /* noop */ }
    try { unlinkSync(`${filePath}-wal`); } catch { /* noop */ }
    try { unlinkSync(`${filePath}-shm`); } catch { /* noop */ }
  }
  cleanupPaths.length = 0;
}

describe("compileLearnings", () => {
  afterEach(cleanup);

  test("returns empty learnings for a repo with no data", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.instructions).toEqual([]);
    expect(learnings.suppressedRules).toEqual([]);
    expect(learnings.preferredCategories).toEqual([]);
    expect(learnings.dislikedCategories).toEqual([]);
    expect(learnings.summary).toBe("no learnings");
  });

  test("includes stored instructions", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveInstructions([
      buildInstruction({ instruction: "skip SRP in tests" }),
      buildInstruction({ instruction: "prefer early returns" }),
    ]);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.instructions).toHaveLength(2);
    expect(learnings.summary).toContain("2 instruction(s)");
  });

  test("suppresses rules with high dislike ratio", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "bad-rule", thumbsUp: 0, thumbsDown: 3 }),
      buildRecord({ ruleId: "bad-rule", thumbsUp: 0, thumbsDown: 2 }),
      buildRecord({ ruleId: "bad-rule", thumbsUp: 1, thumbsDown: 1 }),
    ]);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.suppressedRules).toContain("bad-rule");
    expect(learnings.summary).toContain("1 suppressed rule(s)");
  });

  test("does not suppress rules where dislikes do not exceed 2x likes", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "ok-rule", thumbsUp: 2, thumbsDown: 3 }),
      buildRecord({ ruleId: "ok-rule", thumbsUp: 1, thumbsDown: 1 }),
      buildRecord({ ruleId: "ok-rule", thumbsUp: 1, thumbsDown: 0 }),
    ]);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.suppressedRules).not.toContain("ok-rule");
  });

  test("does not suppress when dislike:like ratio == 2", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "exact-ratio", thumbsUp: 1, thumbsDown: 2 }),
      buildRecord({ ruleId: "exact-ratio", thumbsUp: 1, thumbsDown: 2 }),
    ]);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.suppressedRules).not.toContain("exact-ratio");
    expect(learnings.summary).not.toContain("suppressed");
  });

  test("does not suppress rules with fewer than 3 total reactions", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "low-volume", thumbsUp: 0, thumbsDown: 2 }),
    ]);

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.suppressedRules).not.toContain("low-volume");
  });

  test("classifies category sentiment correctly", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let index = 0; index < 5; index++) {
      store.saveFeedback([
        buildRecord({ category: "liked-cat", thumbsUp: 3, thumbsDown: 0 }),
        buildRecord({ category: "disliked-cat", thumbsUp: 0, thumbsDown: 3 }),
      ]);
    }

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.preferredCategories).toContain("liked-cat");
    expect(learnings.dislikedCategories).toContain("disliked-cat");
  });

  test("excludes neutral categories from both lists", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let index = 0; index < 5; index++) {
      store.saveFeedback([
        buildRecord({ category: "neutral", thumbsUp: 1, thumbsDown: 1 }),
      ]);
    }

    const learnings = compileLearnings("acme/widget", store);
    store.close();

    expect(learnings.preferredCategories).not.toContain("neutral");
    expect(learnings.dislikedCategories).not.toContain("neutral");
  });
});
