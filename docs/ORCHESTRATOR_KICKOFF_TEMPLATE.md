# Agent Tech Lead Kickoff Template

Use this at the start of each execution session with your orchestrator chat.

```text
Act as Agent Tech Lead for Mergewise.

Strategy:
<paste strategy and outcome>

Backlog source:
- ops/backlog.md
- Use only items with status `todo`

Constraints:
- Max 3 parallel tasks
- Bun-only
- Strict TypeScript quality
- No inline comments
- TSDoc-first

Required output:
1) Ranked task plan with:
   - task-id
   - goal
   - scope
   - owner label (agent-1/agent-2/agent-3)
   - branch
   - dependencies
2) Exact setup commands:
   - bun run ops:start-session -- <session-id> <task-id>
   - bun run ops:prompt -- <task-id>
3) Parallel execution groups
4) Merge order
5) Teardown command:
   - bun run wt:cleanup:session <session-id>

Quality gates:
- bun run lint
- bun run typecheck
- bun run test
- bun run build

Output format:
- Keep it concise and execution-first.
- No nested tasks.
- Keep scopes non-overlapping across parallel tasks.
```
