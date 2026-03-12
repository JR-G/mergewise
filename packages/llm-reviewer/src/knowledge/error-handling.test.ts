import { describe, expect, test } from "bun:test";
import { ERROR_HANDLING_KNOWLEDGE } from "./error-handling";
import { retrieveKnowledge } from "./retrieve";
import type { StructuralSignals } from "../signals";

const EMPTY_SIGNALS: StructuralSignals = {
  componentLineCount: 0,
  hookCount: 0,
  importCount: 0,
  maxNestingDepth: 0,
  functionCount: 0,
  maxFunctionLineCount: 0,
  maxParameterCount: 0,
  classCount: 0,
  typeAssertionCount: 0,
};

describe("ERROR_HANDLING_KNOWLEDGE", () => {
  test("has required fields", () => {
    expect(ERROR_HANDLING_KNOWLEDGE.id).toBe("error-handling");
    expect(ERROR_HANDLING_KNOWLEDGE.category).toBe("safety");
    expect(ERROR_HANDLING_KNOWLEDGE.triggerSignals.length).toBeGreaterThan(0);
    expect(ERROR_HANDLING_KNOWLEDGE.triggerClassifications.length).toBeGreaterThan(0);
  });

  test("focuses on structural concerns not defensive coding", () => {
    expect(ERROR_HANDLING_KNOWLEDGE.content).toContain("structural");
    expect(ERROR_HANDLING_KNOWLEDGE.content).toContain("Do NOT suggest adding try-catch");
    expect(ERROR_HANDLING_KNOWLEDGE.content).not.toContain("Bare catch with untyped error");
  });

  test("has at least one example", () => {
    expect(ERROR_HANDLING_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });

  test("scores zero and is not retrieved when triggers are empty", () => {
    const emptyTriggerDoc = { ...ERROR_HANDLING_KNOWLEDGE, triggerSignals: [], triggerClassifications: [] };
    const results = retrieveKnowledge(
      { signals: EMPTY_SIGNALS, fileExtension: ".ts", classifications: [] },
      [emptyTriggerDoc],
    );
    expect(results).toHaveLength(0);
  });
});
