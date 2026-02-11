# AGENTS.md

This file defines how coding agents should work in this repository.

## Purpose

- Enable multiple agents to deliver in parallel with minimal merge conflicts.
- Keep architecture and interfaces stable while features move quickly.

## Core Rules

- Keep PRs/task scope small and single-purpose.
- Prefer additive changes over broad refactors unless explicitly requested.
- Do not edit unrelated files.
- Do not rename/move files unless required for the task.
- Use Bun tooling only for development workflows in this repo.
- Do not introduce npm/pnpm/yarn commands for local dev or CI flows.

## Repo Structure Expectations

- `apps/`: runnable services (webhook API, worker, dashboard)
- `packages/`: shared libraries and contracts
- `rules/`: language/framework rulepacks
- `docs/`: product, architecture, and decision docs

When adding new folders, follow this structure.

## Ownership Boundaries

- Shared contracts live in one place and are imported, not duplicated.
- Cross-package interfaces must be typed and versioned.
- If a task needs contract changes, update consumers in the same PR.

## Parallel Work Safety

- Branch naming: `feat/<area>-<short-description>` or `fix/<area>-<short-description>`.
- One concern per PR.
- Rebase frequently against `main`.
- If active work is detected in the same files, stop and coordinate before continuing.

## Change Quality Gates

Before opening a PR, run:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

If any command fails, do not open the PR.

## CI and Automation

- CI must pass on every PR.
- Dependabot and hook configs should remain enabled.
- Keep pre-push checks aligned with CI commands.

## Documentation Rules

- Update docs when behavior/contracts change.
- Do not add timeline promises in roadmap docs.
- Avoid hype language; keep docs concrete and implementation-oriented.

## Commit Standards

- Make sensible sized commits.
- Use clear commit messages with a single concern.
- Never include claims that assistants or agents built the app.

## Security and Secrets

- Never commit secrets, tokens, or private keys.
- Use environment variables and secret managers for credentials.
- Treat webhook signatures and installation tokens as sensitive.
