#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

cleanup() {
  if [[ -n "${webhook_pid:-}" ]]; then
    kill "${webhook_pid}" 2>/dev/null || true
  fi
  if [[ -n "${worker_pid:-}" ]]; then
    kill "${worker_pid}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

cd "${repo_root}"

bash scripts/dev-run.sh webhook &
webhook_pid=$!

bash scripts/dev-run.sh worker &
worker_pid=$!

wait -n "${webhook_pid}" "${worker_pid}"
