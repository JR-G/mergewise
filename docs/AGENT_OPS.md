# Agent Ops

## Overview

Use `ops/` with worktrees to run multiple agents safely in parallel.

## Files

- `.mergewise-runtime/ops/board.md`: local task tracking (`Todo`, `In Progress`, `Done`)
- `.mergewise-runtime/ops/tasks/*.md`: local task contracts generated from template
- `ops/tasks/TEMPLATE.md`: tracked task contract template
- `ops/ownership.yml`: ownership map for path boundaries

## Flow

1. Create a task file from `ops/tasks/TEMPLATE.md`.
2. Add the task to `.mergewise-runtime/ops/board.md`.
3. Spawn worktree:
   - `bun run ops:new <task-id> <branch-name>`
4. Give the assigned agent the task file and branch.
5. Track active work with:
   - `bun run ops:status`
6. Open PR, review, merge, and move task to `Done`.

## Fast Path

Start everything in one command:

```bash
bun run ops:start -- <task-id> <branch-name> <owner> <scope>
```

Example:

```bash
bun run ops:start -- github-client feat/agent-github-client alice packages/github-client
```

This command:

- Creates `.mergewise-runtime/ops/tasks/<task-id>.md` from template when missing.
- Adds the task row to `.mergewise-runtime/ops/board.md` under `In Progress`.
- Creates the branch worktree using `scripts/worktree.sh`.

Then generate a ready-to-paste agent prompt:

```bash
bun run ops:prompt -- <task-id>
```

Session-based branch naming:

```bash
bun run ops:start-session -- <session-id> <task-id> [owner] [scope] [branch-kind]
```

Example:

```bash
bun run ops:start-session -- s01 github-client
```

Creates branch:

`feat/s01-github-client`

One-command agent launcher (start + prompt + shell in worktree):

```bash
bun run ops:agent -- <session-id> <task-id> [owner] [scope] [branch-kind]
```

Default inference behavior:

- Owner inferred from `ops/ownership.yml` entry for the inferred scope
- Scope inferred from task id and `ops/ownership.yml` (fallback `packages/<task-id>`)
- Branch kind defaults to `feat` (optional `fix`)

Session teardown after merges:

```bash
bun run wt:cleanup:session s01
```

Open PR from task identifier:

```bash
bun run ops:open-pr -- <task-id>
```

## Rules

- Task-to-branch: one task per branch.
- Branch-to-worktree: one branch per worktree.
- Agent-to-worktree: one agent per worktree.
- File boundaries: no edits outside task-allowed paths.
- Completion requires a posted PR URL.
