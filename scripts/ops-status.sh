#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

printf "%-48s %-30s %-10s %s\n" "WORKTREE" "BRANCH" "STATUS" "LAST_COMMIT"

while IFS= read -r worktree_line; do
  worktree_path="$(echo "$worktree_line" | awk '{print $1}')"

  if [[ ! -d "$worktree_path/.git" && ! -f "$worktree_path/.git" && "$worktree_path" != "$REPOSITORY_ROOT" ]]; then
    continue
  fi

  branch_name="$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD)"

  if [[ -n "$(git -C "$worktree_path" status --porcelain)" ]]; then
    worktree_status="dirty"
  else
    worktree_status="clean"
  fi

  last_commit="$(git -C "$worktree_path" log --oneline -n 1)"
  printf "%-48s %-30s %-10s %s\n" "$worktree_path" "$branch_name" "$worktree_status" "$last_commit"
done < <(git -C "$REPOSITORY_ROOT" worktree list --porcelain | awk '/^worktree /{print $2}')
