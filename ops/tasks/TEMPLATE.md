# Task: <task-id>

## Branch

`feat/<area>-<short-description>` or `fix/<area>-<short-description>`

## Goal

Describe exactly what this task must deliver.

## Allowed Paths

- `packages/...`
- `apps/...`

## Definition Of Done

- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- Tests added for changed behavior
- Commit created and branch pushed
- Pull request opened against `main`
- Completion message includes PR URL

## Completion Checklist

- [ ] Scope honored (no files changed outside Allowed Paths)
- [ ] Quality gates passed
- [ ] Branch pushed
- [ ] PR opened
- [ ] PR URL posted back to orchestrator

## Forbidden

- Editing files outside allowed paths
- Merging PR directly
- Skipping quality checks
- Marking task complete without PR URL
