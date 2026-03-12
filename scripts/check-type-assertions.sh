#!/usr/bin/env bash
set -euo pipefail

command -v perl >/dev/null 2>&1 || { echo "check-type-assertions.sh requires perl (not found in PATH)"; exit 1; }

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
        if (/\bas\s+[A-Z]/ && !/\bas\s+const\b/ && !/\bas\s+unknown\b/) {
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
    enclosing_function=$(echo "$staged_content" | sed -n "1,${line_number}p" | perl -ne '
      if (/function\s+(\w+)/) { $fn = $1; }
      END { print $fn // ""; }
    ')

    if [[ "$enclosing_function" == is* ]]; then
      continue
    fi

    echo "Unsafe type assertion at $file:$line_number" >> "$VIOLATIONS_FILE"
    echo "  Use a type guard, runtime validation, or as unknown for intermediate casts." >> "$VIOLATIONS_FILE"
  done
done < <(git diff --cached --diff-filter=ACM --name-only | grep -E '\.(ts|tsx)$' || true)

if [ -s "$VIOLATIONS_FILE" ]; then
  cat "$VIOLATIONS_FILE"
  echo ""
  echo "Type assertions (as SomeType) are only allowed inside type guards (functions named is*), or with as const / as unknown."
  exit 1
fi
