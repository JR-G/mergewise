# Engineering Standards

## Goals

- Keep code predictable under failure.
- Keep long-running services memory-safe.
- Keep module boundaries explicit and maintainable.
- Keep public APIs documented and understandable.

## Required Practices

- Handle errors for filesystem, network, and queue operations.
- Return controlled error responses from request handlers.
- Bound in-memory state used by daemons/workers.
- Use workspace imports for cross-package references.
- Add TSDoc for exported types/functions and behavior contracts.
- Do not use inline code comments; document behavior with TSDoc.
- Do not use single-letter or abbreviated variable names.
- Prefer functional style where practical (pure functions, immutable data handling, and explicit transformations).

## Test Coverage

- All new packages and modules must have contract tests.
- `bun test --coverage` must pass thresholds in CI (80% line, function, and statement).
- Coverage reports are generated on every PR via the `test` CI job.
- Run `bun run test:coverage` locally to check thresholds before pushing.
- Coverage configuration lives in `bunfig.toml`.

## PR Requirements

- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Confirm the quality gate checklist in the PR template.
