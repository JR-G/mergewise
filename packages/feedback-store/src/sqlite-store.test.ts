import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeedbackStore } from "./sqlite-store";
import type { FeedbackRecord, RepoInstruction } from "./types";

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

function buildInstruction(overrides: Partial<RepoInstruction> = {}): RepoInstruction {
  return {
    repoFullName: "acme/widget",
    instruction: "We prefer early returns over nested ifs",
    ruleId: "clean/srp",
    category: "clean",
    sourcePrNumber: 42,
    createdAt: "2026-03-03T12:00:00.000Z",
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

describe("saveInstructions", () => {
  test("persists instruction records to the database", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const instructions = [
      buildInstruction({ instruction: "prefer early returns" }),
      buildInstruction({ instruction: "skip SRP in tests", ruleId: null }),
    ];
    store.saveInstructions(instructions);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const rows = database.query("SELECT instruction, rule_id FROM repo_instructions ORDER BY id").all() as {
      instruction: string;
      rule_id: string | null;
    }[];
    database.close();

    expect(rows).toHaveLength(2);
    expect(rows[0]!.instruction).toBe("prefer early returns");
    expect(rows[1]!.rule_id).toBeNull();
  });

  test("handles empty instructions array without error", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveInstructions([]);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    const count = database.query("SELECT COUNT(*) as cnt FROM repo_instructions").get() as { cnt: number };
    database.close();

    expect(count.cnt).toBe(0);
  });
});

describe("queryInstructions", () => {
  test("returns instructions for the given repo, newest first", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveInstructions([
      buildInstruction({ instruction: "older", createdAt: "2026-01-01T00:00:00.000Z" }),
      buildInstruction({ instruction: "newer", createdAt: "2026-03-01T00:00:00.000Z" }),
    ]);

    const results = store.queryInstructions("acme/widget");
    store.close();

    expect(results).toHaveLength(2);
    expect(results[0]!.instruction).toBe("newer");
    expect(results[1]!.instruction).toBe("older");
  });

  test("does not return instructions for other repos", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveInstructions([
      buildInstruction({ repoFullName: "acme/widget" }),
      buildInstruction({ repoFullName: "other/repo" }),
    ]);

    const results = store.queryInstructions("acme/widget");
    store.close();

    expect(results).toHaveLength(1);
    expect(results[0]!.repoFullName).toBe("acme/widget");
  });

  test("returns empty array when no instructions exist", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const results = store.queryInstructions("acme/widget");
    store.close();

    expect(results).toEqual([]);
  });

  test("limits results to 30", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    const instructions = Array.from({ length: 35 }, (_, index) =>
      buildInstruction({
        instruction: `instruction-${index}`,
        createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    store.saveInstructions(instructions);

    const results = store.queryInstructions("acme/widget");
    store.close();

    expect(results).toHaveLength(30);
  });
});

describe("queryRuleSentiment", () => {
  test("returns aggregated sentiment per rule with at least 3 records", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "rule-a", thumbsUp: 1, thumbsDown: 0 }),
      buildRecord({ ruleId: "rule-a", thumbsUp: 0, thumbsDown: 1 }),
      buildRecord({ ruleId: "rule-a", thumbsUp: 0, thumbsDown: 1 }),
      buildRecord({ ruleId: "rule-b", thumbsUp: 1, thumbsDown: 0 }),
      buildRecord({ ruleId: "rule-b", thumbsUp: 1, thumbsDown: 0 }),
    ]);

    const results = store.queryRuleSentiment("acme/widget");
    store.close();

    expect(results).toHaveLength(1);
    expect(results[0]!.ruleId).toBe("rule-a");
    expect(results[0]!.thumbsUp).toBe(1);
    expect(results[0]!.thumbsDown).toBe(2);
    expect(results[0]!.totalRecords).toBe(3);
  });

  test("returns empty when no rules meet the threshold", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([
      buildRecord({ ruleId: "rule-a", thumbsUp: 1, thumbsDown: 0 }),
    ]);

    const results = store.queryRuleSentiment("acme/widget");
    store.close();

    expect(results).toEqual([]);
  });

  test("orders by thumbs_down descending", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let index = 0; index < 3; index++) {
      store.saveFeedback([
        buildRecord({ findingId: `low-${index}`, ruleId: "low-dislikes", thumbsUp: 1, thumbsDown: 0 }),
        buildRecord({ findingId: `high-${index}`, ruleId: "high-dislikes", thumbsUp: 0, thumbsDown: 3 }),
      ]);
    }

    const results = store.queryRuleSentiment("acme/widget");
    store.close();

    expect(results[0]!.ruleId).toBe("high-dislikes");
  });

  test("limits results to 50", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let ruleIndex = 0; ruleIndex < 55; ruleIndex++) {
      for (let recordIndex = 0; recordIndex < 3; recordIndex++) {
        store.saveFeedback([
          buildRecord({
            findingId: `f-${ruleIndex}-${recordIndex}`,
            ruleId: `rule-${ruleIndex}`,
            thumbsDown: 1,
          }),
        ]);
      }
    }

    const results = store.queryRuleSentiment("acme/widget");
    store.close();

    expect(results).toHaveLength(50);
  });
});

describe("queryCategorySentiment", () => {
  test("returns aggregated sentiment per category with at least 5 records", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let index = 0; index < 5; index++) {
      store.saveFeedback([
        buildRecord({ findingId: `f-${index}`, category: "clean", thumbsUp: 0, thumbsDown: 1 }),
      ]);
    }
    for (let index = 0; index < 4; index++) {
      store.saveFeedback([
        buildRecord({ findingId: `g-${index}`, category: "safety", thumbsUp: 1, thumbsDown: 0 }),
      ]);
    }

    const results = store.queryCategorySentiment("acme/widget");
    store.close();

    expect(results).toHaveLength(1);
    expect(results[0]!.category).toBe("clean");
    expect(results[0]!.thumbsDown).toBe(5);
    expect(results[0]!.totalRecords).toBe(5);
  });

  test("returns empty when no categories meet the threshold", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    store.saveFeedback([buildRecord()]);

    const results = store.queryCategorySentiment("acme/widget");
    store.close();

    expect(results).toEqual([]);
  });

  test("limits results to 20", () => {
    const databasePath = tempDatabasePath();
    cleanupPaths.push(databasePath);
    const store = openFeedbackStore(databasePath);

    for (let categoryIndex = 0; categoryIndex < 25; categoryIndex++) {
      for (let recordIndex = 0; recordIndex < 5; recordIndex++) {
        store.saveFeedback([
          buildRecord({
            findingId: `f-${categoryIndex}-${recordIndex}`,
            category: `cat-${categoryIndex}`,
            thumbsDown: 1,
          }),
        ]);
      }
    }

    const results = store.queryCategorySentiment("acme/widget");
    store.close();

    expect(results).toHaveLength(20);
  });
});
