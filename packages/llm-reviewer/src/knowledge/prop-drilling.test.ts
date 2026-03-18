import { describe, expect, test } from "bun:test";
import { retrieveKnowledge } from "./retrieve";
import { PROP_DRILLING_KNOWLEDGE } from "./prop-drilling";
import { makeSignals } from "./test-helpers";

describe("prop-drilling knowledge document", () => {
  test("retrieves prop-drilling doc for has_hooks signal in .tsx file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 2 }),
      fileExtension: ".tsx",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("does not retrieve prop-drilling doc for has_hooks signal in .ts file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 2 }),
      fileExtension: ".ts",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(false);
  });

  test("retrieves prop-drilling doc for large_component signal in .tsx file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ componentLineCount: 150 }),
      fileExtension: ".tsx",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("retrieves prop-drilling doc for high_import_count signal in .tsx file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ importCount: 11 }),
      fileExtension: ".tsx",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("retrieves prop-drilling doc for prop-drilling classification in .tsx file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".tsx",
      classifications: ["prop-drilling"],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("does not retrieve prop-drilling doc for prop-drilling classification in .ts file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["prop-drilling"],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(false);
  });

  test("retrieves prop-drilling doc for .jsx file extension", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 1 }),
      fileExtension: ".jsx",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("prop-drilling document is properly structured", () => {
    expect(PROP_DRILLING_KNOWLEDGE.id).toBe("prop-drilling");
    expect(PROP_DRILLING_KNOWLEDGE.category).toBe("clean");
    expect(PROP_DRILLING_KNOWLEDGE.fileExtensions).toContain(".tsx");
    expect(PROP_DRILLING_KNOWLEDGE.fileExtensions).toContain(".jsx");
    expect(PROP_DRILLING_KNOWLEDGE.examples.length).toBeGreaterThan(0);
  });

  test("returns empty result for unsupported file extension .js even with signals", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 5 }),
      fileExtension: ".js",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(false);
  });

  test("returns empty result when file extension does not match and no signals present", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".py",
      classifications: [],
    });

    expect(result.some((doc) => doc.id === "prop-drilling")).toBe(false);
  });
});
