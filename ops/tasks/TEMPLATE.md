# Task: <task-id>

## Branch

`<branch-name>`

## Goal

<goal>

## Allowed Paths

<allowed-paths>

## Definition Of Done

- `bun run quality:gates`
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
