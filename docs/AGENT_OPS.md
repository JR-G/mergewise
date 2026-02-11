# Agent Ops

## Overview

Use `ops/` with worktrees to run multiple agents safely in parallel.

## Files

- `ops/board.md`: task tracking (`Todo`, `In Progress`, `Done`)
- `ops/tasks/TEMPLATE.md`: task contract template
- `ops/ownership.yml`: ownership map for path boundaries

## Flow

1. Create a task file from `ops/tasks/TEMPLATE.md`.
2. Add the task to `ops/board.md`.
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

- Creates `ops/tasks/<task-id>.md` from template when missing.
- Adds the task row to `ops/board.md` under `In Progress`.
- Creates the branch worktree using `scripts/worktree.sh`.

Then generate a ready-to-paste agent prompt:

```bash
bun run ops:prompt -- <task-id>
```

## Rules

- Task-to-branch: one task per branch.
- Branch-to-worktree: one branch per worktree.
- Agent-to-worktree: one agent per worktree.
- File boundaries: no edits outside task-allowed paths.
