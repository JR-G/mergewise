#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_ROOT="${WORKTREE_ROOT:-$REPO_ROOT/../mergewise-worktrees}"

usage() {
  cat <<'EOF'
Usage:
  scripts/worktree.sh new <branch>
  scripts/worktree.sh list
  scripts/worktree.sh remove <branch>
  scripts/worktree.sh prune

Notes:
  - Worktrees are created under ../mergewise-worktrees by default.
  - Override location with WORKTREE_ROOT=/custom/path.
EOF
}

ensure_worktree_root() {
  mkdir -p "$WORKTREE_ROOT"
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

main() {
  local cmd="${1:-}"
  shift || true

  case "$cmd" in
    new) cmd_new "$@" ;;
    list) cmd_list ;;
    remove) cmd_remove "$@" ;;
    prune) cmd_prune ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
