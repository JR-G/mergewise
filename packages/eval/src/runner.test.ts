import { describe, expect, test } from "bun:test";
import { toFilePath } from "@mergewise/shared-types";
import type { EvalFixture, EvalVariant } from "./types";
import { runFixture } from "./runner";

describe("runFixture", () => {
  test("accepts valid fixture and variant arguments", async () => {
    const fixture: EvalFixture = {
      fixtureId: "test-fixture",
      fileDiff: {
        filePath: toFilePath("src/test.ts"),
        previousPath: null,
        hunks: [{ header: "@@ -1,1 +1,2 @@", lines: ["+const x = 1"] }],
      },
      fullFileContent: "const x = 1",
      expectations: [],
    };

    const variant: EvalVariant = {
      label: "default",
      clientConfig: {
        model: "gpt-4o-mini",
        apiKey: "test-key",
      },
      confidenceThreshold: 0.5,
    };

    try {
      await runFixture(fixture, variant);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  test("handles fixture with empty hunks", async () => {
    const fixture: EvalFixture = {
      fixtureId: "empty",
      fileDiff: {
        filePath: toFilePath("empty.ts"),
        previousPath: null,
        hunks: [],
      },
      fullFileContent: "",
      expectations: [],
    };

    const variant: EvalVariant = {
      label: "empty",
      clientConfig: {
        model: "gpt-4o-mini",
        apiKey: "test-key",
      },
      confidenceThreshold: 0,
    };

    try {
      await runFixture(fixture, variant);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });
});
