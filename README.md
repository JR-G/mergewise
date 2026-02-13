# Mergewise

Mergewise is a code review product for pull requests.

Development policy: Bun-only for local development and CI. npm is used only for package publishing/distribution.

## Local Pipeline

Current local development flow:

1. `apps/webhook-api` validates pull request webhooks and enqueues jobs via `packages/job-store`.
2. `apps/worker` polls queued jobs, deduplicates by idempotency key, and invokes `packages/rule-engine`.
3. `packages/rule-engine` executes registered rules and returns a deterministic per-job summary payload.

## npm package

Package: `mergewise`  
Status: early access

Install:

```bash
npm i -g mergewise
```

CLI:

```bash
mergewise --help
mergewise --version
```

## Docs

- `docs/USAGE.md`
- `docs/ENGINEERING_STANDARDS.md`
- `docs/WORKTREES.md`
- `docs/AGENT_OPS.md`
- `docs/ORCHESTRATION_PLAYBOOK.md`
- `docs/ORCHESTRATOR_KICKOFF_TEMPLATE.md`

## Contributor Docs

- `AGENTS.md`

## Ops Quick Start

```bash
bun run ops:start -- <task-id> <branch-name> <owner> <scope>
bun run ops:prompt -- <task-id>
bun run ops:status
```

Session-based quick start and teardown:

```bash
bun run ops:start-session -- <session-id> <task-id>
bun run ops:prompt -- <task-id>
bun run wt:cleanup:session <session-id>
```

One-command agent start (creates task/worktree, prints prompt, opens shell):

```bash
bun run ops:agent -- <session-id> <task-id>
```

Open a PR for a task using branch mapping from the runtime board:

```bash
bun run ops:review-ready -- <task-id>
bun run ops:open-pr -- <task-id>
```
