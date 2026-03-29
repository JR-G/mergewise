# Eval Framework

This package now serves two distinct purposes:

1. `Production benchmark`: evaluate the shipped review pipeline on realistic fixtures and score reviewer quality.
2. `Regression guardrails`: keep the existing expectation-matching fixtures to catch obvious regressions in known anti-pattern handling.

The benchmark target is the production reviewer, not an old prompt path. Eval output should answer:

- How good is the shipped reviewer at maintainability/refactoring review?
- Where is it weak: prioritisation, restraint, specificity, or issue detection?
- Did a change improve the reviewer or introduce regressions?

## Philosophy

Frontier-grade evals for this tool are not just "did the model say SRP?".

They should measure:

- `correctness`: the review is materially grounded in the code
- `prioritisation`: the most important maintainability issue is surfaced first
- `restraint`: clean code stays quiet
- `specificity`: recommendations explain engineering cost and what to refactor
- `refactoring depth`: the output suggests a credible decomposition or idiomatic change

## Fixture Layers

### Regression guardrails

These use `expectations.json` and preserve the existing recall/precision style scoring.
They are useful for:

- anti-pattern recall
- false-positive protection
- change detection on known scenarios

They are not enough on their own to guide product quality.

### Production quality fixtures

These add `fixture.json` beside `expectations.json`.

Example:

```json
{
  "executionMode": "pipeline",
  "prTitle": "Add dashboard summary view",
  "prDescription": "Introduces a dashboard that loads active users and metrics in one component.",
  "reviewQuality": {
    "summary": "A single React component now fetches multiple resources, derives UI state inline, and renders unrelated concerns together.",
    "reviewGoal": "Prioritise the structural maintainability problem over incidental performance commentary.",
    "mustFind": [
      {
        "description": "Flags the component as mixing concerns",
        "matchLineRange": [1, 9],
        "matchRecommendationContainsAny": ["extract", "split", "hook", "responsibilit"],
        "required": true
      }
    ],
    "mustAvoid": [],
    "findingCountRange": [1, 2]
  }
}
```

`reviewQuality` adds higher-signal scoring:

- heuristic coverage of required issues
- restraint against unnecessary findings
- prioritisation of the main issue
- optional judge-model assessment with per-dimension rationale

## Running

Production pipeline benchmark:

```bash
LLM_EVAL_API_KEY=... bun run eval --engine pipeline
```

Benchmark-only suite:

```bash
LLM_EVAL_API_KEY=... bun run eval --suite benchmark
```

Regression-only suite:

```bash
LLM_EVAL_API_KEY=... bun run eval --suite regression
```

Benchmark with a judge model for reviewer-quality scoring:

```bash
LLM_EVAL_API_KEY=... \
LLM_EVAL_JUDGE_MODEL=gpt-4.1-mini \
bun run eval --engine pipeline
```

Recommended benchmark run:

```bash
LLM_EVAL_API_KEY=... \
LLM_EVAL_JUDGE_MODEL=gpt-4.1-mini \
bun run eval --suite benchmark
```

Legacy path remains available only as a compatibility baseline:

```bash
LLM_EVAL_API_KEY=... bun run eval --engine legacy
```

## Console Output

The report is split into:

- `Run Summary`: headline benchmark quality and regression guardrails
- `Regression Guardrails`: recall/precision from expectation fixtures
- `Production Quality`: reviewer-quality metrics from fixture rubrics

The intended workflow is:

1. use `Production Quality` to improve the reviewer
2. use `Regression Guardrails` to ensure changes do not break known behaviours

Recommended loops:

1. `bun run eval --suite benchmark` while iterating on output quality
2. `bun run eval --suite regression` before merging prompt or pipeline changes
3. `bun run eval --suite all` for release candidates or larger model changes

## Authoring Guidance

Good production-quality fixtures:

- look like plausible PRs
- include code that is almost good, not cartoonishly bad
- force prioritisation between multiple plausible comments
- include silence cases
- reward one dominant comment over multiple weaker comments when appropriate
- reward code-specific refactoring guidance
- penalise generic "clean code" preaching

Weak fixtures:

- toy snippets whose behaviour is obviously degenerate
- cases where the expected answer depends on one preferred phrasing
- fixtures that reward naming a pattern more than judging the code
