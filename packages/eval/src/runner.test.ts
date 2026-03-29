import { describe, expect, test } from "bun:test";
import { toFilePath } from "@mergewise/shared-types";
import type { EvalFixture, EvalRunOptions, EvalVariant } from "./types";
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
    sourceFiles: new Map([["src/test.ts", "const x = 1"]]),
    expectations: [],
    config: {},
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

const LEGACY_RUN_OPTIONS: EvalRunOptions = { executionMode: "legacy" };

describe("runFixture", () => {
  test("wraps LLM failure with fixture and variant context", async () => {
    let thrownError: unknown;
    try {
      await runFixture(makeFixture(), makeVariant(), LEGACY_RUN_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toMatch(
      /LLM completion failed for fixture "test-fixture" variant "default" in legacy mode/,
    );
  });

  test("includes fixture ID and variant label in error for empty hunks", async () => {
    const fixture = makeFixture({
      fixtureId: "empty-hunks",
      fileDiff: { filePath: toFilePath("empty.ts"), previousPath: null, hunks: [] },
      fullFileContent: "",
      sourceFiles: new Map([["empty.ts", ""]]),
    });

    let thrownError: unknown;
    try {
      await runFixture(fixture, makeVariant({ label: "empty" }), LEGACY_RUN_OPTIONS);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toMatch(
      /LLM completion failed for fixture "empty-hunks" variant "empty" in legacy mode/,
    );
  });
});
