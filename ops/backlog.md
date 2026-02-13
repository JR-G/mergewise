# Backlog

Use this file as the execution source for Agent Tech Lead planning.

## Rules

- Keep items ranked from top (highest priority) to bottom.
- Only plan session tasks from `todo` items.
- Mark item status only as `todo`, `in_progress`, or `done`.
- Move to `done` only after PR merge to `main` and green checks.

## Items

| ID | Initiative | Scope | Status | Notes |
| --- | --- | --- | --- | --- |
| BL-001 | End-to-end analysis pipeline wiring (webhook -> worker -> findings output) | `apps/webhook-api`, `apps/worker`, `packages/rule-engine` | todo | Start with TS/TSX rule path and summary output. |
| BL-002 | Finding posting integration (PR comments/checks) | `packages/github-client`, `apps/worker` | todo | Post bounded, high-signal findings to PR. |
| BL-003 | Config-driven rule enablement and gating | `packages/config-loader`, `packages/rule-engine` | todo | Apply include/exclude and confidence/max-comment gates. |
| BL-004 | Rulepack expansion for TS/React quality and performance smells | `packages/rule-ts-react` | todo | Add deterministic rules beyond unsafe any. |
| BL-005 | Operational hardening (structured logging and error surfaces) | `apps/webhook-api`, `apps/worker` | todo | Keep failures visible and controlled. |
