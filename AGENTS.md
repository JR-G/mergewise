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
- Do not leave unhandled I/O or external-call failures in request handlers.
- Do not add unbounded in-memory collections for long-running processes.
- Do not use deep relative imports for cross-package boundaries.
- Add TSDoc comments for exported types/functions and non-obvious behavior.
- Do not add inline code comments (`//` or block comments inside function bodies).
- Use TSDoc blocks for documentation and behavior notes.
- Do not use single-letter variable names.
- Avoid abbreviated variable names; prefer clear full words.
- Prefer functional programming style where practical (pure functions, immutability, explicit data flow).

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
- Use git worktrees for parallel agent execution (see `docs/WORKTREES.md`).

## Change Quality Gates

Before opening a PR, run:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

If any command fails, do not open the PR.

Every PR must include:
- Failure-mode handling for new I/O boundaries.
- A bounded strategy for any new in-memory state.
- Updated docs when API/contracts or behavior changes.

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

## Package Dependency Direction

- `shared-types` is the leaf dependency — no imports from other internal packages.
- `job-store` depends on `shared-types` only.
- `rule-engine` depends on `shared-types` only.
- `apps/*` may depend on any package but never on each other.
- No app-to-app imports. If two apps need shared logic, extract it to a package.

## Finding Data Flow

1. GitHub sends webhook to `webhook-api`.
2. `webhook-api` validates, builds a job, and enqueues it via `job-store`.
3. `worker` polls `job-store`, deduplicates by idempotency key.
4. `worker` invokes `rule-engine` with PR diffs and optional codebase context.
5. `rule-engine` runs registered rules and returns findings.
6. `worker` applies gating (confidence threshold, max comments, deduplication).
7. `worker` posts surviving findings as GitHub PR comments.

## Rule Authoring Contract

When implementing a new rule:

1. Choose `kind: "stateless"` unless the rule needs repository-wide context (symbols, conventions, file reads outside the diff). Stateless rules are cheaper — the runner skips codebase indexing when only stateless rules are registered.
2. Implement `StatelessRule` or `CodebaseAwareRule` from `@mergewise/shared-types`.
3. Set `confidence` between 0 and 1. The gating layer filters findings below the configured threshold (currently 0.78).
4. Include `evidence` (the code that triggers the finding) and `recommendation` (what to change and why).
5. Include `patchPreview` when the rule can produce a concrete diff suggestion.

## Error Propagation

- `shared-types`: no runtime code, no errors.
- `job-store`: throws on filesystem write failures; skips and logs on read parse errors.
- `rule-engine`: individual rule failures are caught and logged; other rules continue.
- `apps/webhook-api`: catches enqueue failures and returns 503; all other errors return appropriate HTTP status codes.
- `apps/worker`: catches queue read failures and skips the poll cycle; individual job processing failures are logged and skipped.

## When to Add a New Package

Create a new package under `packages/` when:

- The code is needed by two or more consumers (apps or other packages).
- It has a distinct interface boundary (types, a client, a runtime).
- It can be tested in isolation.

Do not create a package for code used by only one consumer — keep it in that consumer's directory.

## Security and Secrets

- Never commit secrets, tokens, or private keys.
- Use environment variables and secret managers for credentials.
- Treat webhook signatures and installation tokens as sensitive.
