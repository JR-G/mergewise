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

  git diff --cached -U0 -- "$file" | perl -e '
    my $new_line = 0;
    while (<STDIN>) {
      if (/^\@\@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+\@\@/) {
        $new_line = $1;
        next;
      }
      if (/^\+/ && !/^\+\+\+/) {
        if (/(rmSync|unlinkSync)\s*\(/ && /force\s*:\s*true/) {
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
    line_count=$(echo "$staged_content" | wc -l | tr -d ' ')
    window_start=$((line_number - 5))
    if [ "$window_start" -lt 1 ]; then
      window_start=1
    fi
    window_end=$((line_number + 5))
    if [ "$window_end" -gt "$line_count" ]; then
      window_end=$line_count
    fi

    window=$(echo "$staged_content" | sed -n "${window_start},${window_end}p")

    if echo "$window" | grep -qE '(try\s*\{|catch\s*\()'; then
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
