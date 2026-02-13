#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_OPS_ROOT="$REPOSITORY_ROOT/.mergewise-runtime/ops"
TASK_IDENTIFIER="${1:-}"
BRANCH_NAME="${2:-}"

print_usage() {
  cat <<'USAGE'
Usage:
  scripts/ops-new.sh <task-id> <branch-name>

Example:
  scripts/ops-new.sh github-client feat/agent-github-client
USAGE
}

validate_safe_value() {
  local value="$1"
  local value_name="$2"
  local allow_slash="${3:-false}"

  if [[ -z "$value" ]]; then
    echo "error: $value_name must not be empty" >&2
    exit 1
  fi

  if [[ "$value" == /* ]]; then
    echo "error: $value_name must not start with '/'" >&2
    exit 1
  fi

  if [[ "$value" == *..* ]]; then
    echo "error: $value_name must not contain '..'" >&2
    exit 1
  fi

  if [[ "$allow_slash" == "false" && "$value" == */* ]]; then
    echo "error: $value_name must not contain '/'" >&2
    exit 1
  fi

  if [[ "$allow_slash" == "true" ]]; then
    if [[ ! "$value" =~ ^[A-Za-z0-9._/-]+$ ]]; then
      echo "error: $value_name contains unsupported characters" >&2
      exit 1
    fi
  elif [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "error: $value_name contains unsupported characters" >&2
    exit 1
  fi
}

if [[ -z "$TASK_IDENTIFIER" || -z "$BRANCH_NAME" ]]; then
  print_usage
  exit 1
fi

validate_safe_value "$TASK_IDENTIFIER" "task-id" "false"
validate_safe_value "$BRANCH_NAME" "branch-name" "true"

TASK_FILE_PATH="$RUNTIME_OPS_ROOT/tasks/${TASK_IDENTIFIER}.md"
TASK_TEMPLATE_PATH="$REPOSITORY_ROOT/ops/tasks/TEMPLATE.md"

mkdir -p "$RUNTIME_OPS_ROOT/tasks"

if [[ ! -f "$TASK_FILE_PATH" ]]; then
  cp "$TASK_TEMPLATE_PATH" "$TASK_FILE_PATH"
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
