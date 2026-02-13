# Agent Tech Lead Playbook

## Purpose

Run multi-agent delivery in a repeatable way where one `Agent Tech Lead` plans and reviews, and execution agents handle isolated PR-sized tasks.

## Inputs

- Strategy statement for the current session
- Backlog source: `ops/backlog.md`
- Session identifier (example: `s02`)
- Parallelism cap (default: `3`)

## Operating Rules

- One milestone at a time.
- One task per branch.
- One branch per worktree.
- One agent per worktree.
- Max `3` parallel tasks unless explicitly raised.
- No overlapping allowed-path scopes across parallel tasks.
- Merge in dependency order, not completion order.

## Task Sizing Rules

- Each task should be one PR.
- Each task should change one concern.
- Prefer `2-6` files per task.
- Keep scope path-focused (example: `packages/github-client`).
- Include explicit acceptance checks:
  - `bun run lint`
  - `bun run typecheck`
  - `bun run test`
  - `bun run build`

## Agent Tech Lead Output Contract

Every planning run must output:

1. Ranked task list:
   - `task-id`
   - `goal`
   - `scope`
   - `owner`
   - `branch`
   - `dependencies`
2. Exact setup commands:
   - `bun run ops:start-session -- <session-id> <task-id>`
   - `bun run ops:prompt -- <task-id>`
3. Parallel execution groups.
4. Merge order.
5. Session teardown command:
   - `bun run wt:cleanup:session <session-id>`

## Setup Flow

1. Agent Tech Lead filters `ops/backlog.md` to `todo` items only.
2. Agent Tech Lead generates task plan from strategy and top backlog items.
3. Start one task per command:
   - `bun run ops:start-session -- <session-id> <task-id>`
4. Generate prompts:
   - `bun run ops:prompt -- <task-id>`
5. Assign each prompt to one agent in its worktree.

## Review And Merge Flow

1. Validate each PR against coding and scope rules.
2. Merge in declared dependency order.
3. Confirm `main` green after final merge.
4. Mark completed backlog items as `done` in `ops/backlog.md`.

## Teardown Flow

After merged PRs:

- `bun run wt:cleanup:session <session-id>`
- `bun run wt:list`

## Escalation Rules

- If a task becomes too large, split it before coding continues.
- If scopes collide, re-plan and reassign before merge conflicts happen.
- If a task requires cross-scope edits, document the exception in the task file before execution.
