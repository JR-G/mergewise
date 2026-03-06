#!/usr/bin/env bash
set -euo pipefail

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

  if [ ! -f "$test_file" ]; then
    echo "Missing test file: $test_file (for $file)"
    missing="yes"
  fi
done < <(git diff --cached --diff-filter=AMR --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -n "$missing" ]; then
  echo ""
  echo "Every changed source file must have a colocated .test.ts file."
  exit 1
fi
