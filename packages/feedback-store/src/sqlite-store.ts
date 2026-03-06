import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CategorySentiment,
  FeedbackRecord,
  FeedbackStore,
  RepoInstruction,
  RuleSentiment,
} from "./types";

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

CREATE TABLE IF NOT EXISTS repo_instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_full_name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  rule_id TEXT,
  category TEXT,
  source_pr_number INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instructions_repo
  ON repo_instructions (repo_full_name);
`;

const DEDUPLICATE_FEEDBACK_SQL = `
DELETE FROM comment_feedback
WHERE id NOT IN (
  SELECT MIN(id) FROM comment_feedback GROUP BY repo_full_name, pr_number, finding_id LIMIT 2147483647
)
`;

const CREATE_UNIQUE_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique_finding
  ON comment_feedback (repo_full_name, pr_number, finding_id)
`;

const INSERT_FEEDBACK_SQL = `
INSERT INTO comment_feedback (
  finding_id, rule_id, category, confidence,
  thumbs_up, thumbs_down, other_reactions,
  repo_full_name, pr_number, trace_id, recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (repo_full_name, pr_number, finding_id) DO UPDATE SET
  rule_id = excluded.rule_id,
  category = excluded.category,
  confidence = excluded.confidence,
  thumbs_up = excluded.thumbs_up,
  thumbs_down = excluded.thumbs_down,
  other_reactions = excluded.other_reactions,
  trace_id = excluded.trace_id,
  recorded_at = excluded.recorded_at
`;

const CREATE_UNIQUE_INSTRUCTION_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_instruction_unique
  ON repo_instructions (repo_full_name, instruction)
`;

const INSERT_INSTRUCTION_SQL = `
INSERT INTO repo_instructions (
  repo_full_name, instruction, rule_id, category,
  source_pr_number, created_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (repo_full_name, instruction) DO UPDATE SET
  rule_id = excluded.rule_id,
  category = excluded.category,
  source_pr_number = excluded.source_pr_number,
  created_at = excluded.created_at
WHERE excluded.created_at > repo_instructions.created_at
`;

const QUERY_INSTRUCTIONS_SQL = `
SELECT repo_full_name, instruction, rule_id, category,
       source_pr_number, created_at
FROM repo_instructions
WHERE repo_full_name = ?
ORDER BY created_at DESC, id DESC
LIMIT 30
`;

const QUERY_RULE_SENTIMENT_SQL = `
SELECT
  rule_id,
  SUM(thumbs_up) AS thumbs_up,
  SUM(thumbs_down) AS thumbs_down,
  COUNT(*) AS total_records
FROM comment_feedback
WHERE repo_full_name = ?
GROUP BY rule_id
HAVING COALESCE(SUM(thumbs_up), 0) + COALESCE(SUM(thumbs_down), 0) >= 3
ORDER BY thumbs_down DESC, rule_id ASC
LIMIT 50
`;

const QUERY_CATEGORY_SENTIMENT_SQL = `
SELECT
  category,
  SUM(thumbs_up) AS thumbs_up,
  SUM(thumbs_down) AS thumbs_down,
  COUNT(*) AS total_records
FROM comment_feedback
WHERE repo_full_name = ?
GROUP BY category
HAVING COUNT(*) >= 5
ORDER BY ABS(SUM(thumbs_down) - SUM(thumbs_up)) DESC, category ASC
LIMIT 20
`;

interface InstructionRow {
  repo_full_name: string;
  instruction: string;
  rule_id: string | null;
  category: string | null;
  source_pr_number: number;
  created_at: string;
}

interface SentimentRow {
  rule_id: string;
  thumbs_up: number;
  thumbs_down: number;
  total_records: number;
}

interface CategoryRow {
  category: string;
  thumbs_up: number;
  thumbs_down: number;
  total_records: number;
}

function mapInstructionRow(row: InstructionRow): RepoInstruction {
  return {
    repoFullName: row.repo_full_name,
    instruction: row.instruction,
    ruleId: row.rule_id,
    category: row.category,
    sourcePrNumber: row.source_pr_number,
    createdAt: row.created_at,
  };
}

function mapSentimentRow(row: SentimentRow): RuleSentiment {
  return {
    ruleId: row.rule_id,
    thumbsUp: row.thumbs_up,
    thumbsDown: row.thumbs_down,
    totalRecords: row.total_records,
  };
}

function mapCategoryRow(row: CategoryRow): CategorySentiment {
  return {
    category: row.category,
    thumbsUp: row.thumbs_up,
    thumbsDown: row.thumbs_down,
    totalRecords: row.total_records,
  };
}

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

  const feedbackIndexExists = database
    .query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_feedback_unique_finding' LIMIT 1")
    .get();
  if (!feedbackIndexExists) {
    database.run(DEDUPLICATE_FEEDBACK_SQL);
    database.run(CREATE_UNIQUE_INDEX_SQL);
  }

  database.run(CREATE_UNIQUE_INSTRUCTION_INDEX_SQL);

  const insertFeedbackStatement = database.prepare(INSERT_FEEDBACK_SQL);
  const insertManyFeedback = database.transaction((records: readonly FeedbackRecord[]) => {
    for (const record of records) {
      insertFeedbackStatement.run(
        record.findingId, record.ruleId, record.category, record.confidence,
        record.thumbsUp, record.thumbsDown, record.otherReactions,
        record.repoFullName, record.prNumber, record.traceId, record.recordedAt,
      );
    }
  });

  const insertInstructionStatement = database.prepare(INSERT_INSTRUCTION_SQL);
  const insertManyInstructions = database.transaction((instructions: readonly RepoInstruction[]) => {
    for (const instruction of instructions) {
      insertInstructionStatement.run(
        instruction.repoFullName, instruction.instruction, instruction.ruleId,
        instruction.category, instruction.sourcePrNumber, instruction.createdAt,
      );
    }
  });

  const queryInstructionsStmt = database.prepare(QUERY_INSTRUCTIONS_SQL);
  const queryRuleSentimentStmt = database.prepare(QUERY_RULE_SENTIMENT_SQL);
  const queryCategorySentimentStmt = database.prepare(QUERY_CATEGORY_SENTIMENT_SQL);

  const MAX_BATCH_SIZE = 500;

  return {
    saveFeedback(records) {
      for (let offset = 0; offset < records.length; offset += MAX_BATCH_SIZE) {
        insertManyFeedback(records.slice(offset, offset + MAX_BATCH_SIZE));
      }
    },
    saveInstructions(instructions) {
      for (let offset = 0; offset < instructions.length; offset += MAX_BATCH_SIZE) {
        insertManyInstructions(instructions.slice(offset, offset + MAX_BATCH_SIZE));
      }
    },
    queryInstructions(repoFullName) {
      return (queryInstructionsStmt.all(repoFullName) as InstructionRow[]).map(mapInstructionRow);
    },
    queryRuleSentiment(repoFullName) {
      return (queryRuleSentimentStmt.all(repoFullName) as SentimentRow[]).map(mapSentimentRow);
    },
    queryCategorySentiment(repoFullName) {
      return (queryCategorySentimentStmt.all(repoFullName) as CategoryRow[]).map(mapCategoryRow);
    },
    close() {
      database.close();
    },
  };
}
