import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { NESTED_CONDITIONALS_KNOWLEDGE } from "./nested-conditionals";
import type { StructuralSignals } from "../signals";

function makeSignals(overrides: Partial<StructuralSignals> = {}): StructuralSignals {
  return {
    componentLineCount: 0,
    hookCount: 0,
    importCount: 0,
    maxNestingDepth: 0,
    functionCount: 0,
    maxFunctionLineCount: 0,
    maxParameterCount: 0,
    classCount: 0,
    typeAssertionCount: 0,
    ...overrides,
  };
}

describe("nested-conditionals knowledge document", () => {
  test("retrieves nested-conditionals doc for high_nesting signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxNestingDepth: 5 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("retrieves nested-conditionals doc for large_function signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxFunctionLineCount: 60 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("retrieves nested-conditionals doc for nested-conditionals classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["nested-conditionals"],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("retrieves nested-conditionals doc for complex-boolean classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["complex-boolean"],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("retrieves nested-conditionals doc for god-function-growth classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["god-function-growth"],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("does not retrieve nested-conditionals doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "nested-conditionals")).toBe(false);
  });

  test("nested-conditionals document is properly structured", () => {
    expect(NESTED_CONDITIONALS_KNOWLEDGE.id).toBe("nested-conditionals");
    expect(NESTED_CONDITIONALS_KNOWLEDGE.category).toBe("clean");
    expect(NESTED_CONDITIONALS_KNOWLEDGE.triggerSignals).toContain("high_nesting");
    expect(NESTED_CONDITIONALS_KNOWLEDGE.triggerSignals).toContain("large_function");
    expect(NESTED_CONDITIONALS_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
