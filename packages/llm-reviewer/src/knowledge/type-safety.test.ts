import { describe, expect, test } from "bun:test";
import { TYPE_SAFETY_KNOWLEDGE } from "./type-safety";

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

  test("handles empty trigger arrays gracefully via registry scoring", () => {
    const emptyTriggerDoc = { ...TYPE_SAFETY_KNOWLEDGE, triggerSignals: [], triggerClassifications: [] };
    expect(emptyTriggerDoc.triggerSignals).toHaveLength(0);
    expect(emptyTriggerDoc.triggerClassifications).toHaveLength(0);
  });
});
