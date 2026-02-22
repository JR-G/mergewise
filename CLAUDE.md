# Mergewise

Refactoring-focused code review tool for PRs. TypeScript and React first.

## Project Structure

Monorepo with tsconfig path aliases (not Bun workspaces).

- `apps/webhook-api` — validates GitHub webhooks, enqueues jobs
- `apps/worker` — polls jobs, runs analysis pipeline, posts PR comments + check output
- `packages/rule-engine` — executes rules, gating, delivery
- `packages/rule-ts-react` — AST-based TS/React rules (anti-patterns)
- `packages/llm-reviewer` — OpenAI-compatible LLM review with file selection, token budgets, structural signals
- `packages/config-loader` — `.mergewise.yml` config (gating, rules, LLM settings)
- `packages/github-client` — GitHub API wrapper (PRs, comments, check runs, file content)
- `packages/job-store` — in-memory job queue

## Tech & Tooling

- **Runtime:** Bun for dev/CI, npm for publishing
- **Pre-commit hooks:** lefthook — runs lint + typecheck + test + build
- **Linting:** ESLint with strict-type-checked + stylistic-type-checked presets
- **Quality gates:** script checks cross-package imports, catch logging, secrets

## Testing

Test **behaviour**, not implementation details or internal state.

A test should answer: "if someone breaks a user-facing behaviour, will this test catch it?"

### Never assert on

- Collection sizes or exact counts (e.g. `expect(items).toHaveLength(18)`)
- Internal data shape or category distribution
- Enum membership or schema validation of internal structures

### Never write tests that

- Break when you add, remove, or rename an internal entry but no behaviour changed
- Snapshot internal state rather than verifying observable outcomes
- Duplicate checks that belong at the type or build level

### Good examples

- "when I pass patterns to `buildSystemPrompt`, the prompt contains their detection hints"
- "when the LLM returns a finding on a non-added line, it gets discarded"
- "each catalogue pattern's detectionHint appears in the default prompt"

### Bad examples

- "ANTI_PATTERNS has exactly 18 entries"
- "has expected category distribution: 5 clean, 6 idiomatic, 3 safety, 4 perf"
- "every pattern has non-empty required fields" (schema validation, not behaviour)
