#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_IDENTIFIER="${1:-}"
BRANCH_NAME="${2:-}"
TASK_FILE_PATH="$REPOSITORY_ROOT/ops/tasks/${TASK_IDENTIFIER}.md"

print_usage() {
  cat <<'USAGE'
Usage:
  scripts/ops-new.sh <task-id> <branch-name>

Example:
  scripts/ops-new.sh github-client feat/agent-github-client
USAGE
}

if [[ -z "$TASK_IDENTIFIER" || -z "$BRANCH_NAME" ]]; then
  print_usage
  exit 1
fi

if [[ ! -f "$TASK_FILE_PATH" ]]; then
  cp "$REPOSITORY_ROOT/ops/tasks/TEMPLATE.md" "$TASK_FILE_PATH"
  echo "Created task file from template: $TASK_FILE_PATH"
fi

bash "$REPOSITORY_ROOT/scripts/worktree.sh" new "$BRANCH_NAME"

WORKTREE_ROOT_PATH="${WORKTREE_ROOT:-$REPOSITORY_ROOT/../mergewise-worktrees}"
WORKTREE_PATH="$WORKTREE_ROOT_PATH/$BRANCH_NAME"

cat <<OUTPUT
Task ready.

Task file:
  $TASK_FILE_PATH

Worktree path:
  $WORKTREE_PATH

Next:
  1) Open the task file and fill Goal/Allowed Paths/DoD.
  2) Start agent in the worktree path.
  3) Track status with: bun run ops:status
OUTPUT
