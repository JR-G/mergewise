import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { LONG_PARAMETER_LIST_KNOWLEDGE } from "./long-parameter-list";
import { makeSignals } from "./test-helpers";

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

  test("does not retrieve doc when maxParameterCount is at threshold boundary (3)", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxParameterCount: 3 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(false);
  });

  test("retrieves doc when maxParameterCount crosses threshold (4)", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxParameterCount: 4 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("long-parameter-list document is properly structured", () => {
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.id).toBe("long-parameter-list");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.category).toBe("clean");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.triggerSignals).toContain("high_param_count");
    expect(LONG_PARAMETER_LIST_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });
});
