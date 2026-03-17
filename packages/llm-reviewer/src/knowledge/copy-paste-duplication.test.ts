import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { COPY_PASTE_DUPLICATION_KNOWLEDGE } from "./copy-paste-duplication";
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

describe("copy-paste-duplication knowledge document", () => {
  test("retrieves copy-paste-duplication doc for high_function_count signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ functionCount: 10 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("retrieves copy-paste-duplication doc for large_function signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxFunctionLineCount: 60 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("retrieves copy-paste-duplication doc for duplication classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["duplication"],
    });

    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("retrieves copy-paste-duplication doc for mixed-responsibilities classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["mixed-responsibilities"],
    });

    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("does not retrieve copy-paste-duplication doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(false);
  });

  test("copy-paste-duplication document is properly structured", () => {
    expect(COPY_PASTE_DUPLICATION_KNOWLEDGE.id).toBe("copy-paste-duplication");
    expect(COPY_PASTE_DUPLICATION_KNOWLEDGE.category).toBe("clean");
    expect(COPY_PASTE_DUPLICATION_KNOWLEDGE.triggerSignals).toContain("high_function_count");
    expect(COPY_PASTE_DUPLICATION_KNOWLEDGE.triggerSignals).toContain("large_function");
    expect(COPY_PASTE_DUPLICATION_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
