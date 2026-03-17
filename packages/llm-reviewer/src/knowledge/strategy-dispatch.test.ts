import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { STRATEGY_DISPATCH_KNOWLEDGE } from "./strategy-dispatch";
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

describe("strategy-dispatch knowledge document", () => {
  test("retrieves strategy-dispatch doc for high_nesting signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxNestingDepth: 5 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("retrieves strategy-dispatch doc for large_function signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxFunctionLineCount: 60 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("retrieves strategy-dispatch doc for strategy-pattern classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["strategy-pattern"],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("retrieves strategy-dispatch doc for switch-chain classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["switch-chain"],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("retrieves strategy-dispatch doc for god-function-growth classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["god-function-growth"],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("does not retrieve strategy-dispatch doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(false);
  });

  test("strategy-dispatch document is properly structured", () => {
    expect(STRATEGY_DISPATCH_KNOWLEDGE.id).toBe("strategy-dispatch");
    expect(STRATEGY_DISPATCH_KNOWLEDGE.category).toBe("clean");
    expect(STRATEGY_DISPATCH_KNOWLEDGE.triggerSignals).toContain("high_nesting");
    expect(STRATEGY_DISPATCH_KNOWLEDGE.triggerSignals).toContain("large_function");
    expect(STRATEGY_DISPATCH_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
