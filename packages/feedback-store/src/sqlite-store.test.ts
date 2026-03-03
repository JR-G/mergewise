import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeedbackStore } from "./sqlite-store";
import type { FeedbackRecord } from "./types";

function tempDatabasePath(): string {
  return join(tmpdir(), `feedback-test-${crypto.randomUUID()}.db`);
}

function buildRecord(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    findingId: "finding-1",
    ruleId: "ts-react/no-any",
    category: "safety",
    confidence: "0.92",
    thumbsUp: 3,
    thumbsDown: 1,
    otherReactions: 0,
    repoFullName: "acme/widget",
    prNumber: 42,
    traceId: "trace-abc",
    recordedAt: "2026-03-03T12:00:00.000Z",
    ...overrides,
  };
}

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const filePath of cleanupPaths) {
    try {
      unlinkSync(filePath);
    } catch {
      /* already removed */
    }
    try {
      unlinkSync(`${filePath}-wal`);
    } catch {
      /* WAL file may not exist */
    }
    try {
      unlinkSync(`${filePath}-shm`);
    } catch {
      /* SHM file may not exist */
    }
  }
  cleanupPaths.length = 0;
});

describe("openFeedbackStore", () => {
  test("persists feedback records to the database", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const records = [
      buildRecord({ findingId: "f1", thumbsUp: 5 }),
      buildRecord({ findingId: "f2", thumbsDown: 2, prNumber: 99 }),
    ];
    store.saveFeedback(records);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const rows = database.query("SELECT finding_id, thumbs_up, thumbs_down, pr_number FROM comment_feedback ORDER BY finding_id").all() as {
      finding_id: string;
      thumbs_up: number;
      thumbs_down: number;
      pr_number: number;
    }[];
    database.close();

    expect(rows.some((row) => row.finding_id === "f1" && row.thumbs_up === 5)).toBe(true);
    expect(rows.some((row) => row.finding_id === "f2" && row.thumbs_down === 2 && row.pr_number === 99)).toBe(true);
  });

  test("handles empty records array without error", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([]);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const count = database.query("SELECT COUNT(*) as cnt FROM comment_feedback").get() as { cnt: number };
    database.close();

    expect(count.cnt).toBe(0);
  });

  test("close is idempotent", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.close();
    expect(() => store.close()).not.toThrow();
  });

  test("stores all record fields correctly", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const record = buildRecord();
    store.saveFeedback([record]);
    store.close();

    interface FeedbackRow {
      rule_id: string;
      category: string;
      confidence: string;
      thumbs_up: number;
      thumbs_down: number;
      other_reactions: number;
      repo_full_name: string;
      pr_number: number;
      trace_id: string;
      recorded_at: string;
    }

    const database = new Database(databasePath, { readonly: true });
    const row = database.query("SELECT * FROM comment_feedback WHERE finding_id = ?").get(record.findingId) as FeedbackRow;
    database.close();

    expect(row.rule_id).toBe(record.ruleId);
    expect(row.category).toBe(record.category);
    expect(row.confidence).toBe(record.confidence);
    expect(row.thumbs_up).toBe(record.thumbsUp);
    expect(row.thumbs_down).toBe(record.thumbsDown);
    expect(row.other_reactions).toBe(record.otherReactions);
    expect(row.repo_full_name).toBe(record.repoFullName);
    expect(row.pr_number).toBe(record.prNumber);
    expect(row.trace_id).toBe(record.traceId);
    expect(row.recorded_at).toBe(record.recordedAt);
  });
});
