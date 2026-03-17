#!/usr/bin/env bash
set -euo pipefail

# Scans staged .ts files (excluding tests and branded.ts itself) for new
# interface or type declarations that use raw string/number for domain fields
# that should use branded types from @mergewise/shared-types.

DOMAIN_FIELDS='(filePath|previousPath|repo|repoFullName|repo_full_name|headSha|head_sha|sha|scanId|scan_id|jobId|job_id|ruleId|rule_id|confidence|prNumber|pr_number|installationId|installation_id|full_name)'

# Separate pattern for "line" — requires word-boundary context to avoid
# matching substrings like "timeline" or "deadline". POSIX ERE does not
# support \b, so we anchor with non-alpha characters instead.
LINE_FIELD='(^|[^a-zA-Z_])line[?]?:\s*(string|number)(\s|;|$)'

violations=""

while IFS= read -r file; do
  case "$file" in
    *.test.ts|*.test.tsx) continue ;;
    */branded.ts) continue ;;
    packages/debt-scanner/*) continue ;;
    packages/feedback-store/*) continue ;;
  esac

  added=$(git diff --cached -U0 -- "$file" | grep '^+' | grep -v '^+++' || true)
  if [ -z "$added" ]; then
    continue
  fi

  if echo "$added" | grep -Eq "${DOMAIN_FIELDS}[?]?:\s*(string|number)(\s|;|$)" || echo "$added" | grep -Eq "${LINE_FIELD}"; then
    echo "Raw domain type found in: $file"
    echo "$added" | grep -E "${DOMAIN_FIELDS}[?]?:\s*(string|number)(\s|;|$)" | head -5
    echo "$added" | grep -E "${LINE_FIELD}" | head -5
    echo ""
    violations="yes"
  fi
done < <(git diff --cached --diff-filter=ACM --name-only | grep -E '\.tsx?$' || true)

if [ -n "$violations" ]; then
  echo "Use branded types from @mergewise/shared-types instead of raw string/number for domain values."
  echo "See packages/shared-types/src/branded.ts for available types."
  exit 1
fi
