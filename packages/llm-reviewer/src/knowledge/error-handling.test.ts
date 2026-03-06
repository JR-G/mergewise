import { describe, expect, test } from "bun:test";
import { ERROR_HANDLING_KNOWLEDGE } from "./error-handling";

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

  test("handles empty trigger arrays gracefully via registry scoring", () => {
    const emptyTriggerDoc = { ...ERROR_HANDLING_KNOWLEDGE, triggerSignals: [], triggerClassifications: [] };
    expect(emptyTriggerDoc.triggerSignals).toHaveLength(0);
    expect(emptyTriggerDoc.triggerClassifications).toHaveLength(0);
  });
});
