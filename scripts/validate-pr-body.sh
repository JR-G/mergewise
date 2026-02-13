#!/usr/bin/env bash
set -euo pipefail

PR_BODY_INPUT="${PR_BODY:-}"

if [ -z "$PR_BODY_INPUT" ]; then
  if [ "${CI:-}" = "true" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "pr-body validation failed: PR_BODY is empty in CI" >&2
    exit 1
  fi
  echo "pr-body validation skipped: PR_BODY is empty"
  exit 0
fi

normalize() {
  tr '[:upper:]' '[:lower:]'
}

contains_checked_item() {
  local expected_text="$1"
  if printf "%s\n" "$PR_BODY_INPUT" | normalize | grep -Fq -- "[x] ${expected_text}"; then
    return 0
  fi
  return 1
}

required_checked_items=(
  "\`bun run lint\`"
  "\`bun run typecheck\`"
  "\`bun run test\`"
  "\`bun run build\`"
  "i handled failure modes for new i/o or network boundaries."
  "i avoided unbounded in-memory growth in long-running paths."
  "i used workspace package imports for cross-package dependencies."
  "i avoided deep relative cross-package imports in tests and runtime code."
  "i avoided secret-like fixture values (for example private key block markers)."
  "i ensured async timer callbacks handle promise rejections explicitly."
  "i added/updated tsdoc for exported apis or behavior changes."
  "i updated user-facing docs where relevant."
)

for required_checked_item in "${required_checked_items[@]}"; do
  if ! contains_checked_item "$required_checked_item"; then
    echo "pr-body validation failed: missing checked item -> $required_checked_item" >&2
    exit 1
  fi
done

echo "pr-body validation passed"
