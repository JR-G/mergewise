## Summary

- 

## Checks

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build`

## Quality Gate

- [ ] I handled failure modes for new I/O or network boundaries.
- [ ] I avoided unbounded in-memory growth in long-running paths.
- [ ] I used workspace package imports for cross-package dependencies.
- [ ] I avoided deep relative cross-package imports in tests and runtime code.
- [ ] I avoided secret-like fixture values (for example private key block markers).
- [ ] I ensured async timer callbacks handle promise rejections explicitly.
- [ ] I added/updated TSDoc for exported APIs or behavior changes.
- [ ] I updated user-facing docs where relevant.
