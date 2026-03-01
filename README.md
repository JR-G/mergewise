# Mergewise

![Mergewise MW mark](apps/site/assets/m-w-logo.svg)

Mergewise is a code review product for pull requests.

Development policy: Bun-only for local development and CI. npm is used only for package publishing/distribution.

## Local Pipeline

Current local development flow:

1. `apps/webhook-api` validates pull request webhooks and enqueues jobs via `packages/job-store`.
2. `apps/worker` polls queued jobs, deduplicates by idempotency key, and invokes `packages/rule-engine`.
3. `packages/rule-engine` executes registered rules and returns a deterministic per-job summary payload.

## Website Deploy Scope

The website project at `apps/site` uses `apps/site/vercel.json` with an `ignoreCommand`.
Preview and production deployments are skipped when a commit does not include changes under `apps/site`.

## Local Env Setup

Create local secrets file (gitignored):

```bash
cp .env.example .env.local
```

Set values in `.env.local`:

- `GITHUB_APP_ID`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY_PATH` (absolute path to downloaded GitHub App `.pem`)
- `WEBHOOK_PORT` (defaults to `8787`)

`dev:*:local` commands load `.env.local` automatically via `bun --env-file`, so no manual `export` is required.

Run services with env auto-loaded:

```bash
bun run dev:webhook:local
bun run dev:worker:local
```

Run both together:

```bash
bun run dev:stack
```

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

## Contributor Docs

- `AGENTS.md`

## Quality Gates

```bash
bun run quality:gates
```
