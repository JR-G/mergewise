import { describe, expect, test } from "bun:test";
import { TYPE_SAFETY_KNOWLEDGE } from "./type-safety";
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

describe("TYPE_SAFETY_KNOWLEDGE", () => {
  test("has required fields", () => {
    expect(TYPE_SAFETY_KNOWLEDGE.id).toBe("type-safety");
    expect(TYPE_SAFETY_KNOWLEDGE.category).toBe("safety");
    expect(TYPE_SAFETY_KNOWLEDGE.triggerSignals.length).toBeGreaterThan(0);
    expect(TYPE_SAFETY_KNOWLEDGE.triggerClassifications.length).toBeGreaterThan(0);
  });

  test("focuses on structural type design not defensive validation", () => {
    expect(TYPE_SAFETY_KNOWLEDGE.content).toContain("structural");
    expect(TYPE_SAFETY_KNOWLEDGE.content).toContain("Do NOT suggest adding null checks");
    expect(TYPE_SAFETY_KNOWLEDGE.content).not.toContain("Non-null assertions (!)");
  });

  test("has at least one example", () => {
    expect(TYPE_SAFETY_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });

  test("scores zero and is not retrieved when triggers are empty", () => {
    const emptyTriggerDoc = { ...TYPE_SAFETY_KNOWLEDGE, triggerSignals: [], triggerClassifications: [] };
    const results = retrieveKnowledge(
      { signals: EMPTY_SIGNALS, fileExtension: ".ts", classifications: [] },
      [emptyTriggerDoc],
    );
    expect(results).toHaveLength(0);
  });
});
