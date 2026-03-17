import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { INTERFACE_SEGREGATION_KNOWLEDGE } from "./interface-segregation";
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

describe("interface-segregation knowledge document", () => {
  test("retrieves interface-segregation doc for has_classes signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ classCount: 3 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves interface-segregation doc for has_type_assertions signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ typeAssertionCount: 2 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves interface-segregation doc for interface-change classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["interface-change"],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves interface-segregation doc for type-safety classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["type-safety"],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves interface-segregation doc for fat-interface classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["fat-interface"],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves interface-segregation doc for lsp-violation classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["lsp-violation"],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("does not retrieve interface-segregation doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(false);
  });

  test("interface-segregation document is properly structured", () => {
    expect(INTERFACE_SEGREGATION_KNOWLEDGE.id).toBe("interface-segregation");
    expect(INTERFACE_SEGREGATION_KNOWLEDGE.category).toBe("clean");
    expect(INTERFACE_SEGREGATION_KNOWLEDGE.triggerSignals).toContain("has_classes");
    expect(INTERFACE_SEGREGATION_KNOWLEDGE.triggerSignals).toContain("has_type_assertions");
    expect(INTERFACE_SEGREGATION_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
