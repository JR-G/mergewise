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

## Rules

- One task per branch.
- One branch per worktree.
- One agent per worktree.
- No file edits outside task allowed paths.
