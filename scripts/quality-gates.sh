#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPOSITORY_ROOT"

fail() {
  echo "quality-gate failed: $1" >&2
  exit 1
}

if rg -n --glob '**/*.ts' --glob '**/*.tsx' --glob '!node_modules/**' --glob '!dist/**' --glob '!.mergewise-runtime/**' "from ['\"](\\.\\./)+(apps|packages)/" . >/tmp/mergewise-quality-imports.txt 2>/dev/null; then
  echo "disallowed deep relative cross-package imports found:" >&2
  cat /tmp/mergewise-quality-imports.txt >&2
  fail "use workspace package imports instead of deep relative imports"
fi

if rg -n --glob '**/*.ts' --glob '**/*.tsx' --glob '!node_modules/**' --glob '!dist/**' --glob '!.mergewise-runtime/**' --glob '!coverage/**' "-----BEGIN [A-Z ]*PRIVATE KEY-----" . >/tmp/mergewise-quality-secrets.txt 2>/dev/null; then
  echo "private-key-like fixture text found:" >&2
  cat /tmp/mergewise-quality-secrets.txt >&2
  fail "replace secret-like fixtures with placeholders"
fi

check_set_interval_catch_in_file() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    return 0
  fi

  awk -v file_path="$file_path" '
    {
      lines[NR] = $0
    }
    END {
      for (line_number = 1; line_number <= NR; line_number += 1) {
        if (lines[line_number] ~ /setInterval[[:space:]]*\(/) {
          has_void_call = 0
          has_catch = 0

          for (candidate = line_number + 1; candidate <= NR && candidate <= line_number + 18; candidate += 1) {
            if (lines[candidate] ~ /void[[:space:]]+[A-Za-z0-9_]+\(.*\)/) {
              has_void_call = 1
            }
            if (lines[candidate] ~ /\.catch[[:space:]]*\(/) {
              has_catch = 1
            }
            if (lines[candidate] ~ /^[[:space:]]*}\s*,\s*[^)]*$/ || lines[candidate] ~ /^[[:space:]]*\)\s*;[[:space:]]*$/) {
              break
            }
          }

          if (has_void_call == 1 && has_catch == 0) {
            printf("setInterval async invocation missing .catch in %s:%d\n", file_path, line_number) > "/dev/stderr"
            exit 1
          }
        }
      }
    }
  ' "$file_path" || fail "setInterval async invocation must handle rejections in $file_path"
}

while IFS= read -r timer_file; do
  check_set_interval_catch_in_file "$timer_file"
done < <(rg -l --glob '**/*.ts' --glob '**/*.tsx' --glob '!node_modules/**' --glob '!dist/**' --glob '!.mergewise-runtime/**' "setInterval\\(" apps packages || true)

check_catch_logging_in_file() {
  local file_path="$1"
  if [ ! -f "$file_path" ]; then
    return 0
  fi

  awk -v file_path="$file_path" '
    {
      lines[NR] = $0
    }
    END {
      for (line_number = 1; line_number <= NR; line_number += 1) {
        if (lines[line_number] ~ /catch[[:space:]]*\(/) {
          has_logging = 0
          for (candidate = line_number + 1; candidate <= NR && candidate <= line_number + 14; candidate += 1) {
            if (lines[candidate] ~ /(console\.error|errorLogger|onRuleExecutionError)/) {
              has_logging = 1
              break
            }
            if (lines[candidate] ~ /^[[:space:]]*}/) {
              break
            }
          }

          if (has_logging == 0) {
            printf("missing catch logging in %s:%d\n", file_path, line_number) > "/dev/stderr"
            exit 1
          }
        }
      }
    }
  ' "$file_path" || fail "catch blocks must include contextual logging in $file_path"
}

check_catch_logging_in_file "apps/worker/src/index.ts"
check_catch_logging_in_file "apps/worker/src/main.ts"
check_catch_logging_in_file "packages/rule-engine/src/index.ts"

if rg -n --glob '**/*.ts' --glob '**/*.tsx' --glob '!node_modules/**' --glob '!dist/**' --glob '!.mergewise-runtime/**' "buildJobSummary\\([^)]*new Date\\(\\)\\.toISOString\\(\\)" apps packages tests >/tmp/mergewise-quality-time.txt 2>/dev/null; then
  echo "non-deterministic timestamp passed directly into buildJobSummary:" >&2
  cat /tmp/mergewise-quality-time.txt >&2
  fail "inject processedAt timestamp via dependency/time source"
fi

echo "quality-gates passed"
