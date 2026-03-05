# Mergewise

## Commands

```bash
bun run lint            # ESLint strict-type-checked
bun run typecheck       # tsc --noEmit
bun run test            # bun test
bun run build           # tsc -p tsconfig.build.json
bun run quality:gates   # cross-package imports, secrets, catch logging
```

Run all four before opening a PR. If any fail, fix before proceeding.

## Don'ts

- No inline comments (`//` inside function bodies) — use TSDoc for documentation
- No single-letter or abbreviated variable names
- No npm/pnpm/yarn — Bun only
- No deep relative imports across package boundaries — use workspace imports
- No unbounded lists, strings, or loops that grow with input size
- No output to external APIs (GitHub comments, check runs) without size limits
- No unhandled I/O or network failures in request handlers
- No committing secrets, tokens, or private keys
- No mentioning AI tools or assistants in commits, PRs, or code
- No app-to-app imports — extract shared logic to a package
- No `SELECT *` without `LIMIT` — all variable-length SQL queries must be bounded
- No `parseInt` / `Number()` without immediate validation — check `isFinite` and range before use
- No passing raw parsed numbers through multiple functions — validate at the boundary, use the validated value downstream
- No nested if statements — use guard clauses and early returns

## Testing

Test the failure mode, not just the happy path. Every new feature must include tests for:
- What happens with duplicate/malformed input (e.g. duplicate DB keys, invalid JSON from LLM)
- What happens when the process restarts mid-operation (e.g. in-memory state is lost)
- What happens when a new code path is added alongside an existing one (e.g. callbacks, hooks, telemetry registered on the old path must be exercised on the new path too)

Test behaviour, not implementation.

Bad — breaks when internals change:
```typescript
expect(results).toHaveLength(3);
expect(results[0].category).toBe("clean");
```

Good — verifies observable outcome:
```typescript
expect(results.some(r => r.filePath === "src/index.ts")).toBe(true);
expect(output).toContain("Review completed");
```

### Boundary tests

Functions that accept numeric input must have tests for boundary conditions:

- Zero, negative, and very large values
- `NaN` and non-integer floats where integers are expected
- Empty collections passed to functions that iterate

Functions that produce output (reports, SQL results, API payloads) must verify the output is bounded.

## Pre-PR Verification

Before opening a PR, verify each against your actual diff — do not tick blindly:

- Any list/string that grows with input has a bound or cap
- Any output sent to external APIs has a size limit
- New async operations handle errors and rejections
- New I/O boundaries have failure-mode handling
- Any `parseInt` / `Number()` call is immediately validated (isFinite, range check)
- Any SQL query returning variable-length results has a LIMIT clause
- Functions accepting numeric params have boundary tests (0, negative, large)
- No function trusts its callers for input validity — validate at boundaries
