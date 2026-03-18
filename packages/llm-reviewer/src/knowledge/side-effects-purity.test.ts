import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { SIDE_EFFECTS_PURITY_KNOWLEDGE } from "./side-effects-purity";
import { makeSignals } from "./test-helpers";

describe("side-effects-purity knowledge document", () => {
  test("retrieves side-effects-purity doc for high_function_count signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ functionCount: 10 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("retrieves side-effects-purity doc for side-effects classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["side-effects"],
    });

    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("retrieves side-effects-purity doc for mixed-responsibilities classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["mixed-responsibilities"],
    });

    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("retrieves side-effects-purity doc for query-side-effect classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["query-side-effect"],
    });

    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("does not retrieve side-effects-purity doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(false);
  });

  test("side-effects-purity document is properly structured", () => {
    expect(SIDE_EFFECTS_PURITY_KNOWLEDGE.id).toBe("side-effects-purity");
    expect(SIDE_EFFECTS_PURITY_KNOWLEDGE.category).toBe("clean");
    expect(SIDE_EFFECTS_PURITY_KNOWLEDGE.triggerSignals).toContain("high_function_count");
    expect(SIDE_EFFECTS_PURITY_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
