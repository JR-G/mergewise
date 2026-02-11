#!/usr/bin/env bash
set -euo pipefail

THRESHOLD="${1:-80}"
LCOV_FILE="${2:-coverage/lcov.info}"

if [ ! -f "$LCOV_FILE" ]; then
  echo "error: lcov file not found at $LCOV_FILE"
  echo "run 'bun test --coverage' first"
  exit 1
fi

lines_found=0
lines_hit=0
functions_found=0
functions_hit=0

while IFS= read -r line; do
  case "$line" in
    LF:*) lines_found=$((lines_found + ${line#LF:})) ;;
    LH:*) lines_hit=$((lines_hit + ${line#LH:})) ;;
    FNF:*) functions_found=$((functions_found + ${line#FNF:})) ;;
    FNH:*) functions_hit=$((functions_hit + ${line#FNH:})) ;;
  esac
done < "$LCOV_FILE"

if [ "$lines_found" -eq 0 ]; then
  echo "error: no line data found in $LCOV_FILE"
  exit 1
fi

line_pct=$((lines_hit * 100 / lines_found))

if [ "$functions_found" -eq 0 ]; then
  func_pct=100
else
  func_pct=$((functions_hit * 100 / functions_found))
fi

echo "line coverage:     ${line_pct}% (${lines_hit}/${lines_found})"
echo "function coverage: ${func_pct}% (${functions_hit}/${functions_found})"
echo "threshold:         ${THRESHOLD}%"

failed=0

if [ "$line_pct" -lt "$THRESHOLD" ]; then
  echo "FAIL: line coverage ${line_pct}% is below ${THRESHOLD}%"
  failed=1
fi

if [ "$func_pct" -lt "$THRESHOLD" ]; then
  echo "FAIL: function coverage ${func_pct}% is below ${THRESHOLD}%"
  failed=1
fi

if [ "$failed" -eq 1 ]; then
  exit 1
fi

echo "PASS: coverage meets threshold"
