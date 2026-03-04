import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FeedbackRecord, FeedbackStore } from "./types";

const DEFAULT_DATABASE_PATH = ".mergewise-runtime/feedback.db";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS comment_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  confidence TEXT NOT NULL,
  thumbs_up INTEGER NOT NULL,
  thumbs_down INTEGER NOT NULL,
  other_reactions INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_repo_pr
  ON comment_feedback (repo_full_name, pr_number);
`;

const INSERT_SQL = `
INSERT INTO comment_feedback (
  finding_id, rule_id, category, confidence,
  thumbs_up, thumbs_down, other_reactions,
  repo_full_name, pr_number, trace_id, recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Opens a SQLite-backed feedback store, creating the database and schema if needed.
 *
 * @param databasePath - File path for the SQLite database. Defaults to `.mergewise-runtime/feedback.db`.
 */
export function openFeedbackStore(databasePath = DEFAULT_DATABASE_PATH): FeedbackStore {
  const parentDirectory = dirname(databasePath);
  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, { recursive: true });
  }

  const database = new Database(databasePath);
  database.run("PRAGMA journal_mode = WAL;");
  database.run(SCHEMA_SQL);

  const insertStatement = database.prepare(INSERT_SQL);
  const insertMany = database.transaction((records: readonly FeedbackRecord[]) => {
    for (const record of records) {
      insertStatement.run(
        record.findingId,
        record.ruleId,
        record.category,
        record.confidence,
        record.thumbsUp,
        record.thumbsDown,
        record.otherReactions,
        record.repoFullName,
        record.prNumber,
        record.traceId,
        record.recordedAt,
      );
    }
  });

  return {
    saveFeedback(records: readonly FeedbackRecord[]): void {
      if (records.length === 0) {
        return;
      }
      insertMany(records);
    },

    close(): void {
      database.close();
    },
  };
}
