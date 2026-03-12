#!/usr/bin/env bash
set -euo pipefail

command -v perl >/dev/null 2>&1 || { echo "check-parse-int-validation.sh requires perl (not found in PATH)"; exit 1; }

VIOLATIONS_FILE=$(mktemp)
trap 'rm -f "$VIOLATIONS_FILE"' EXIT

while IFS= read -r file; do
  case "$file" in
    *.test.ts|*.test.tsx) continue ;;
  esac

  staged_content=$(git show ":$file" 2>/dev/null) || continue
  line_count=$(echo "$staged_content" | wc -l | tr -d ' ')

  git diff --cached -U0 -- "$file" | perl -e '
    my $new_line = 0;
    while (<STDIN>) {
      if (/^\@\@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+\@\@/) {
        $new_line = $1;
        next;
      }
      if (/^\+/ && !/^\+\+\+/) {
        if (/\b(parseInt|Number)\s*\(/) {
          print "$new_line\n";
        }
        $new_line++;
        next;
      }
      if (/^-/ && !/^---/) {
        next;
      }
    }
  ' | while read -r line_number; do
    window_end=$((line_number + 5))
    if [ "$window_end" -gt "$line_count" ]; then
      window_end=$line_count
    fi

    window=$(echo "$staged_content" | sed -n "${line_number},${window_end}p")

    if echo "$window" | grep -qE '(isFinite|isNaN|Number\.isFinite|Number\.isInteger|[<>]=?)'; then
      continue
    fi

    echo "Unvalidated parseInt/Number() at $file:$line_number" >> "$VIOLATIONS_FILE"
    echo "  Add isFinite, isNaN, Number.isFinite, Number.isInteger, or a range check within 5 lines." >> "$VIOLATIONS_FILE"
  done
done < <(git diff --cached --diff-filter=ACM --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -s "$VIOLATIONS_FILE" ]; then
  cat "$VIOLATIONS_FILE"
  echo ""
  echo "Every parseInt() or Number() call must be validated immediately (isFinite, range check, etc.)."
  exit 1
fi
