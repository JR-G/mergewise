import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { DEPENDENCY_INVERSION_KNOWLEDGE } from "./dependency-inversion";
import { makeSignals } from "./test-helpers";

describe("dependency-inversion knowledge document", () => {
  test("retrieves dependency-inversion doc for high_import_count signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ importCount: 11 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("retrieves dependency-inversion doc for has_classes signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ classCount: 3 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("retrieves dependency-inversion doc for hardcoded-dependency classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["hardcoded-dependency"],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("retrieves dependency-inversion doc for api-boundary classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["api-boundary"],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("retrieves dependency-inversion doc for coupling classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["coupling"],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("does not retrieve dependency-inversion doc when no signals or classifications match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(false);
  });

  test("dependency-inversion document is properly structured", () => {
    expect(DEPENDENCY_INVERSION_KNOWLEDGE.id).toBe("dependency-inversion");
    expect(DEPENDENCY_INVERSION_KNOWLEDGE.category).toBe("clean");
    expect(DEPENDENCY_INVERSION_KNOWLEDGE.triggerSignals).toContain("high_import_count");
    expect(DEPENDENCY_INVERSION_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
