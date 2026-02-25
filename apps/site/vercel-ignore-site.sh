#!/usr/bin/env bash
set -euo pipefail

repository_root_path="$(git rev-parse --show-toplevel)"
comparison_base_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"
comparison_head_sha="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

cd "${repository_root_path}"

if ! git rev-parse --verify "${comparison_head_sha}" >/dev/null 2>&1; then
  comparison_head_sha="HEAD"
fi

if [ -n "${comparison_base_sha}" ] && git rev-parse --verify "${comparison_base_sha}" >/dev/null 2>&1; then
  :
elif git rev-parse --verify HEAD^ >/dev/null 2>&1; then
  comparison_base_sha="HEAD^"
else
  printf '%s\n' "No previous commit available. Continuing deployment."
  exit 1
fi

if git diff --quiet "${comparison_base_sha}" "${comparison_head_sha}" -- apps/site; then
  printf '%s\n' "No apps/site changes detected. Skipping deployment."
  exit 0
fi

printf '%s\n' "apps/site changes detected. Continuing deployment."
exit 1
