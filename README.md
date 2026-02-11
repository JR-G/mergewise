# Mergewise

Mergewise is a code review product for pull requests.

Development policy: Bun-only for local development and CI. npm is used only for package publishing/distribution.

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
