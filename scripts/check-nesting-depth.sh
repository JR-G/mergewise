#!/usr/bin/env bash
set -euo pipefail

command -v perl >/dev/null 2>&1 || { echo "check-nesting-depth.sh requires perl (not found in PATH)"; exit 1; }

MAX_IF_INDENT=12

VIOLATIONS_FILE=$(mktemp)
trap 'rm -f "$VIOLATIONS_FILE"' EXIT

while IFS= read -r file; do
  case "$file" in
    *.test.ts|*.test.tsx) continue ;;
  esac

  staged_content=$(git show ":$file" 2>/dev/null) || continue

  echo "$staged_content" | perl -ne '
    if (/^(\s+)if\s*\(/) {
      my $indent = length($1);
      if ($indent >= '"$MAX_IF_INDENT"') {
        print "$. $indent\n";
      }
    }
  ' | while read -r line_number indent; do
    echo "Deeply nested if statement at $file:$line_number (indent: ${indent} spaces)" >> "$VIOLATIONS_FILE"
    echo "  Use guard clauses, early returns, or extract a helper function." >> "$VIOLATIONS_FILE"
  done
done < <(git diff --cached --diff-filter=ACM --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -s "$VIOLATIONS_FILE" ]; then
  cat "$VIOLATIONS_FILE"
  echo ""
  echo "If statements indented ${MAX_IF_INDENT}+ spaces indicate deep nesting. Flatten with guard clauses or helpers."
  exit 1
fi
