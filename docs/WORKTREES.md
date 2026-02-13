# Worktrees

Use git worktrees so multiple agents can work in parallel without branch collisions.

## Create a Worktree

```bash
bun run wt:new feat/rulepack-ts-react
```

This creates a sibling directory:

`../mergewise-worktrees/feat/rulepack-ts-react`

## Create a Session-Named Worktree

```bash
bun run wt:new:session s01 github-client
```

Default branch format:

`feat/s01-github-client`

Optional branch kind:

```bash
bun run wt:new:session s01 github-client fix
```

Creates:

`fix/s01-github-client`

## List Worktrees

```bash
bun run wt:list
```

## Remove a Worktree

```bash
bun run wt:remove feat/rulepack-ts-react
```

## Cleanup One Session

```bash
bun run wt:cleanup:session s01
```

This removes local merged branches and worktrees for:

- `feat/s01-*`
- `fix/s01-*`

## Cleanup All Worktrees

```bash
bun run wt:cleanup:all
```

This removes every linked worktree except the repository root worktree, prunes stale metadata, and attempts to switch the root checkout to `main`.

## Prune Stale Metadata

```bash
bun run wt:prune
```

## Notes

- Keep one branch per worktree.
- Do not run multiple agents in the same worktree path.
- Push each branch and open a PR independently.
- Branch names containing `/` create nested directories (for example `feat/x` -> `../mergewise-worktrees/feat/x`).
