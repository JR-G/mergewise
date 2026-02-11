# Worktrees

Use git worktrees so multiple agents can work in parallel without branch collisions.

## Create a Worktree

```bash
bun run wt:new feat/rulepack-ts-react
```

This creates a sibling directory:

`../mergewise-worktrees/feat/rulepack-ts-react`

## List Worktrees

```bash
bun run wt:list
```

## Remove a Worktree

```bash
bun run wt:remove feat/rulepack-ts-react
```

## Prune Stale Metadata

```bash
bun run wt:prune
```

## Notes

- Keep one branch per worktree.
- Do not run multiple agents in the same worktree path.
- Push each branch and open a PR independently.
- Branch names containing `/` create nested directories (for example `feat/x` -> `../mergewise-worktrees/feat/x`).
