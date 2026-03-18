import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { INTERFACE_SEGREGATION_KNOWLEDGE } from "./interface-segregation";
import { makeSignals } from "./test-helpers";

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

  test("duplicate classifications return the doc exactly once", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["interface-change", "interface-change"],
    });

    const matching = result.filter((doc) => doc.id === INTERFACE_SEGREGATION_KNOWLEDGE.id);
    expect(matching.length).toBe(1);
  });

  test("malformed classification values do not cause errors", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["", "   ", "unknown-gibberish-xyz"] as readonly string[],
    });

    expect(result.some((doc) => doc.id === INTERFACE_SEGREGATION_KNOWLEDGE.id)).toBe(false);
  });

  test("malformed classifications alongside valid signal still returns the doc", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ classCount: 3 }),
      fileExtension: ".ts",
      classifications: ["", "   "] as readonly string[],
    });

    expect(result.some((doc) => doc.id === INTERFACE_SEGREGATION_KNOWLEDGE.id)).toBe(true);
  });
});
