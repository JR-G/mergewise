#!/usr/bin/env bash
set -euo pipefail

command -v perl >/dev/null 2>&1 || { echo "check-force-delete.sh requires perl (not found in PATH)"; exit 1; }

VIOLATIONS_FILE=$(mktemp)
trap 'rm -f "$VIOLATIONS_FILE"' EXIT

while IFS= read -r file; do
  case "$file" in
    *.test.ts|*.test.tsx) continue ;;
  esac

  staged_content=$(git show ":$file" 2>/dev/null) || continue
  line_count=$(echo "$staged_content" | wc -l | tr -d ' ')

  echo "$staged_content" | perl -ne '
    if (/\b(rmSync|unlinkSync)\s*\(/) {
      print "$.\n";
    }
  ' | while read -r line_number; do
    window_end=$((line_number + 5))
    if [ "$window_end" -gt "$line_count" ]; then
      window_end=$line_count
    fi

    call_window=$(echo "$staged_content" | sed -n "${line_number},${window_end}p")

    if ! echo "$call_window" | grep -q 'force\s*:\s*true'; then
      continue
    fi

    surround_start=$((line_number - 5))
    if [ "$surround_start" -lt 1 ]; then
      surround_start=1
    fi

    surround_window=$(echo "$staged_content" | sed -n "${surround_start},${window_end}p")

    if echo "$surround_window" | grep -qE '(try\s*\{|catch\s*\()'; then
      continue
    fi

    echo "Unhandled force delete at $file:$line_number" >> "$VIOLATIONS_FILE"
    echo "  rmSync/unlinkSync with force: true must be wrapped in try/catch." >> "$VIOLATIONS_FILE"
  done
done < <(git diff --cached --diff-filter=ACM --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -s "$VIOLATIONS_FILE" ]; then
  cat "$VIOLATIONS_FILE"
  echo ""
  echo "rmSync/unlinkSync with force: true silently swallows errors. Wrap in try/catch."
  exit 1
fi
