#!/usr/bin/env bash
set -euo pipefail

command -v perl >/dev/null 2>&1 || { echo "check-test-files.sh requires perl (not found in PATH)"; exit 1; }

missing=""

while IFS= read -r file; do
  # Skip test files, type definitions, and declaration files
  case "$file" in
    *.test.ts|*.test.tsx|*.d.ts) continue ;;
    *-types.ts|*/types.ts) continue ;;
    */main.ts|*/server.ts) continue ;;
    */test-helpers.ts|*/fixtures.ts|*/fixtures/*) continue ;;
    */index.ts) continue ;;
    packages/shared-types/*) continue ;;
    *-patterns.ts) continue ;;
  esac

  if echo "$file" | grep -qE '\.tsx$'; then
    test_file="${file%.tsx}.test.tsx"
  else
    test_file="${file%.ts}.test.ts"
  fi

  if ! git show ":$test_file" >/dev/null 2>&1; then
    echo "Missing test file: $test_file (for $file)"
    missing="yes"
  fi
done < <(git diff --cached --diff-filter=AMR --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -n "$missing" ]; then
  echo ""
  echo "Every changed source file must have a colocated .test.ts file."
  exit 1
fi

# Check that test files in the diff contain at least one empty/boundary test
BOUNDARY_PATTERN='(empty|no |zero|missing|without|undefined|null|none|invalid|malformed|duplicate)'
no_boundary=""

while IFS= read -r test_file; do
  case "$test_file" in
    *.test.ts|*.test.tsx) ;;
    *) continue ;;
  esac

  if ! git show ":$test_file" 2>/dev/null | perl -0777 -ne "exit 0 if /(test|it)(?:\.[a-z]+(?:\([^)]*\))?)?\s*\(\s*(?:'[^']*?${BOUNDARY_PATTERN}|\"[^\"]*?${BOUNDARY_PATTERN}|\`[^\`]*?${BOUNDARY_PATTERN})/si; exit 1"; then
    echo "No empty/boundary test found in: $test_file"
    no_boundary="yes"
  fi
done < <(git diff --cached --diff-filter=AMR --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -n "$no_boundary" ]; then
  echo ""
  echo "Every test file must include at least one test for empty, missing, or invalid input."
  exit 1
fi
