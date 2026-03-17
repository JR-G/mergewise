import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { LONG_PARAMETER_LIST_KNOWLEDGE } from "./long-parameter-list";
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

describe("long-parameter-list knowledge document", () => {
  test("retrieves long-parameter-list doc for high_param_count signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxParameterCount: 6 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("retrieves long-parameter-list doc for interface-change classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["interface-change"],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("retrieves long-parameter-list doc for long-parameter-list classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["long-parameter-list"],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("does not retrieve long-parameter-list doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxParameterCount: 3 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(false);
  });

  test("long-parameter-list document is properly structured", () => {
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.id).toBe("long-parameter-list");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.category).toBe("clean");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.triggerSignals).toContain("high_param_count");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
