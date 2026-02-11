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

## PR Requirements

- Run `bun run lint`.
- Run `bun run typecheck`.
- Run `bun run test`.
- Run `bun run build`.
- Confirm the quality gate checklist in the PR template.
