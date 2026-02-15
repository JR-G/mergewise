#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_ROOT/../mergewise-worktrees}"

usage() {
  cat <<'EOF'
Usage:
  scripts/worktree.sh new <branch>
  scripts/worktree.sh new-session <session-id> <task-name> [branch-kind]
  scripts/worktree.sh list
  scripts/worktree.sh remove <branch>
  scripts/worktree.sh cleanup-session <session-id>
  scripts/worktree.sh cleanup-all
  scripts/worktree.sh prune

Notes:
  - Worktrees are created under ../mergewise-worktrees by default.
  - Override location with WORKTREE_ROOT=/custom/path.
  - branch-kind defaults to feat and can be feat or fix.
EOF
}

ensure_worktree_root() {
  mkdir -p "$WORKTREE_ROOT"
}

validate_name_segment() {
  local value="$1"
  local value_name="$2"

  if [[ -z "$value" ]]; then
    echo "error: $value_name must not be empty"
    exit 1
  fi

  if [[ ! "$value" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "error: $value_name must match ^[a-z0-9][a-z0-9-]*$"
    exit 1
  fi
}

worktree_path_for_branch() {
  local branch="$1"
  printf "%s/%s\n" "$WORKTREE_ROOT" "$branch"
}

cmd_new() {
  local branch="${1:-}"
  if [[ -z "$branch" ]]; then
    echo "Missing branch name."
    usage
    exit 1
  fi

  ensure_worktree_root
  local wt_path
  wt_path="$(worktree_path_for_branch "$branch")"

  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$REPO_ROOT" worktree add "$wt_path" "$branch"
  else
    git -C "$REPO_ROOT" worktree add -b "$branch" "$wt_path"
  fi

  echo "Created worktree: $wt_path"
}

cmd_new_session() {
  local session_id="${1:-}"
  local task_name="${2:-}"
  local branch_kind="${3:-feat}"

  validate_name_segment "$session_id" "session-id"
  validate_name_segment "$task_name" "task-name"

  if [[ "$branch_kind" != "feat" && "$branch_kind" != "fix" ]]; then
    echo "error: branch-kind must be feat or fix"
    exit 1
  fi

  local branch_name="${branch_kind}/${session_id}-${task_name}"
  cmd_new "$branch_name"
}

cmd_list() {
  git -C "$REPO_ROOT" worktree list
}

cmd_remove() {
  local branch="${1:-}"
  if [[ -z "$branch" ]]; then
    echo "Missing branch name."
    usage
    exit 1
  fi

  local wt_path
  wt_path="$(worktree_path_for_branch "$branch")"
  git -C "$REPO_ROOT" worktree remove "$wt_path"
  echo "Removed worktree: $wt_path"
}

cmd_prune() {
  git -C "$REPO_ROOT" worktree prune
  echo "Pruned stale worktree metadata."
}

cmd_cleanup_session() {
  local session_id="${1:-}"
  validate_name_segment "$session_id" "session-id"

  local branch_patterns=(
    "feat/${session_id}-"
    "fix/${session_id}-"
  )
  local removed_count=0
  local skipped_count=0

  for branch_pattern in "${branch_patterns[@]}"; do
    while IFS= read -r branch_name; do
      [[ -z "$branch_name" ]] && continue

      local worktree_path
      worktree_path="$(worktree_path_for_branch "$branch_name")"
      if [[ -d "$worktree_path" || -f "$worktree_path/.git" || -d "$worktree_path/.git" ]]; then
        git -C "$REPO_ROOT" worktree remove "$worktree_path" || true
      fi

      if git -C "$REPO_ROOT" merge-base --is-ancestor "$branch_name" "main"; then
        git -C "$REPO_ROOT" branch -D "$branch_name"
        removed_count=$((removed_count + 1))
      else
        echo "Skipped unmerged branch: $branch_name"
        skipped_count=$((skipped_count + 1))
      fi
    done < <(git -C "$REPO_ROOT" branch --format='%(refname:short)' | grep "^${branch_pattern}" || true)
  done

  echo "Session cleanup complete."
  echo "Removed merged branches: $removed_count"
  echo "Skipped unmerged branches: $skipped_count"
}

cmd_cleanup_all() {
  local repository_root_real_path
  repository_root_real_path="$(cd "$REPO_ROOT" && pwd -P)"
  local removed_count=0
  local skipped_count=0

  while IFS= read -r worktree_path; do
    [[ -z "$worktree_path" ]] && continue

    local worktree_real_path
    if worktree_real_path="$(cd "$worktree_path" 2>/dev/null && pwd -P)"; then
      :
    else
      worktree_real_path="$worktree_path"
    fi

    if [[ "$worktree_real_path" == "$repository_root_real_path" ]]; then
      continue
    fi

    if git -C "$REPO_ROOT" worktree remove "$worktree_path"; then
      removed_count=$((removed_count + 1))
    else
      echo "Skipped worktree: $worktree_path"
      skipped_count=$((skipped_count + 1))
    fi
  done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree /{print substr($0,10)}')

  git -C "$REPO_ROOT" worktree prune

  if ! git -C "$REPO_ROOT" switch main; then
    echo "Skipped branch switch to main in $REPO_ROOT"
  fi

  echo "Cleanup complete."
  echo "Removed worktrees: $removed_count"
  echo "Skipped worktrees: $skipped_count"
}

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    new) cmd_new "$@" ;;
    new-session) cmd_new_session "$@" ;;
    list) cmd_list ;;
    remove) cmd_remove "$@" ;;
    cleanup-session) cmd_cleanup_session "$@" ;;
    cleanup-all) cmd_cleanup_all ;;
    prune) cmd_prune ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
