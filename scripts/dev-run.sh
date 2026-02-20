#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"

if [[ ! -f "${repo_root}/.env.local" ]]; then
  echo "error: .env.local not found. Copy .env.example to .env.local and set values." >&2
  exit 1
fi

service="${1:-}"

case "${service}" in
  webhook)
    exec bun --env-file="${repo_root}/.env.local" run apps/webhook-api/src/main.ts
    ;;
  worker)
    exec bun --env-file="${repo_root}/.env.local" run apps/worker/src/main.ts
    ;;
  *)
    echo "usage: bash scripts/dev-run.sh <webhook|worker>" >&2
    exit 1
    ;;
esac
