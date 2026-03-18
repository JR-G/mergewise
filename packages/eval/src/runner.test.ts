import { describe, expect, test } from "bun:test";
import { toFilePath } from "@mergewise/shared-types";
import type { EvalFixture, EvalVariant } from "./types";
import { runFixture } from "./runner";

function makeFixture(overrides?: Partial<EvalFixture>): EvalFixture {
  return {
    fixtureId: "test-fixture",
    fileDiff: {
      filePath: toFilePath("src/test.ts"),
      previousPath: null,
      hunks: [{ header: "@@ -1,1 +1,2 @@", lines: ["+const x = 1"] }],
    },
    fullFileContent: "const x = 1",
    expectations: [],
    ...overrides,
  };
}

function makeVariant(overrides?: Partial<EvalVariant>): EvalVariant {
  return {
    label: "default",
    clientConfig: { model: "gpt-4o-mini", apiKey: "test-key" },
    confidenceThreshold: 0.5,
    ...overrides,
  };
}

describe("runFixture", () => {
  test("wraps LLM failure with fixture and variant context", async () => {
    let thrownError: unknown;
    try {
      await runFixture(makeFixture(), makeVariant());
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toMatch(
      /LLM completion failed for fixture "test-fixture" variant "default"/,
    );
  });

  test("includes fixture ID and variant label in error for empty hunks", async () => {
    const fixture = makeFixture({
      fixtureId: "empty-hunks",
      fileDiff: { filePath: toFilePath("empty.ts"), previousPath: null, hunks: [] },
      fullFileContent: "",
    });

    let thrownError: unknown;
    try {
      await runFixture(fixture, makeVariant({ label: "empty" }));
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toMatch(
      /LLM completion failed for fixture "empty-hunks" variant "empty"/,
    );
  });
});
