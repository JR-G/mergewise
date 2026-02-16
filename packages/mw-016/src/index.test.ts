import { describe, expect, test } from "bun:test";

import { analyseTaskGoal, isConcreteGoalText } from "./index";

describe("mw-016 task goal analysis", () => {
  test("returns placeholder goal and marks it non-concrete", () => {
    const markdownContent = `# Task: mw-016

## Goal

Describe exactly what this task must deliver.

## Allowed Paths

- packages/...
`;

    const analysis = analyseTaskGoal(markdownContent);

    expect(analysis.goalText).toBe("Describe exactly what this task must deliver.");
    expect(analysis.isConcreteGoal).toBe(false);
  });

  test("returns concrete goal text when section is filled", () => {
    const markdownContent = `# Task: mw-100

## Goal

Implement idempotency key deduplication in worker job polling.

## Allowed Paths

- apps/worker
`;

    const analysis = analyseTaskGoal(markdownContent);

    expect(analysis.goalText).toBe(
      "Implement idempotency key deduplication in worker job polling.",
    );
    expect(analysis.isConcreteGoal).toBe(true);
  });

  test("returns null goal when goal section is missing", () => {
    const markdownContent = `# Task: mw-100\n\n## Allowed Paths\n\n- apps/worker\n`;

    const analysis = analyseTaskGoal(markdownContent);

    expect(analysis.goalText).toBeNull();
    expect(analysis.isConcreteGoal).toBe(false);
  });

  test("isConcreteGoalText rejects blank and placeholder values", () => {
    expect(isConcreteGoalText("   ")).toBe(false);
    expect(isConcreteGoalText("Describe exactly what this task must deliver.")).toBe(
      false,
    );
  });

  test("isConcreteGoalText accepts concrete goals", () => {
    expect(isConcreteGoalText("Add retry backoff support for token exchange.")).toBe(
      true,
    );
  });
});
