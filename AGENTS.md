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
- No editing unrelated files
- No renaming/moving files unless required for the task

## Testing

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

## Pre-PR Verification

Before opening a PR, verify each against your actual diff — do not tick blindly:

- Any list/string that grows with input has a bound or cap
- Any output sent to external APIs has a size limit
- New async operations handle errors and rejections
- New I/O boundaries have failure-mode handling
