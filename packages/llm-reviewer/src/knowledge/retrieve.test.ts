import { describe, expect, test } from "bun:test";
import type { StructuralSignals } from "../signals";
import type { KnowledgeDocument } from "../pipeline-types";
import { retrieveKnowledge } from "./retrieve";
import { KNOWLEDGE_REGISTRY } from "./registry";

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

function makeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "test-doc",
    title: "Test Document",
    category: "clean",
    triggerSignals: [],
    triggerClassifications: [],
    fileExtensions: [],
    content: "Test content.",
    examples: [],
    ...overrides,
  };
}

describe("retrieveKnowledge", () => {
  test("returns empty array when no signals match", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result).toEqual([]);
  });

  test("returns react-hooks doc for .tsx file with hooks", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 2 }),
      fileExtension: ".tsx",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "react-hooks")).toBe(true);
  });

  test("does not return react-hooks doc for .ts file", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ hookCount: 2 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "react-hooks")).toBe(false);
  });

  test("returns god-function doc for high function count", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ functionCount: 10 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "god-function")).toBe(true);
  });

  test("returns error-handling doc for high nesting", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxNestingDepth: 5 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "error-handling")).toBe(true);
  });

  test("returns type-safety doc for type assertions", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ typeAssertionCount: 5 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "type-safety")).toBe(true);
  });

  test("classification matches score higher than signal matches", () => {
    const docA = makeDocument({
      id: "signal-only",
      triggerSignals: ["high_function_count"],
      triggerClassifications: [],
    });
    const docB = makeDocument({
      id: "classification-match",
      triggerSignals: [],
      triggerClassifications: ["error-handling"],
    });

    const result = retrieveKnowledge(
      {
        signals: makeSignals({ functionCount: 10 }),
        fileExtension: ".ts",
        classifications: ["error-handling"],
      },
      [docA, docB],
    );

    expect(result[0]!.id).toBe("classification-match");
  });

  test("caps results at 5 documents", () => {
    const registry = Array.from({ length: 10 }, (_, index) =>
      makeDocument({
        id: `doc-${index}`,
        triggerSignals: ["high_function_count"],
      }),
    );

    const result = retrieveKnowledge(
      {
        signals: makeSignals({ functionCount: 10 }),
        fileExtension: ".ts",
        classifications: [],
      },
      registry,
    );

    expect(result.length).toBe(5);
  });

  test("excludes extension-restricted documents when extension does not match", () => {
    const registry = [
      makeDocument({
        id: "react-only",
        triggerSignals: ["has_hooks"],
        fileExtensions: [".tsx", ".jsx"],
      }),
    ];

    const result = retrieveKnowledge(
      {
        signals: makeSignals({ hookCount: 5 }),
        fileExtension: ".ts",
        classifications: [],
      },
      registry,
    );

    expect(result).toEqual([]);
  });

  test("uses built-in registry by default", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ functionCount: 10, maxFunctionLineCount: 50 }),
      fileExtension: ".ts",
      classifications: ["god-function-growth"],
    });

    expect(result.length).toBeGreaterThan(0);
    expect(KNOWLEDGE_REGISTRY.length).toBeGreaterThan(0);
  });

  test("does not throw for zero signal values", () => {
    const invoke = () =>
      retrieveKnowledge({
        signals: makeSignals(),
        fileExtension: ".ts",
        classifications: [],
      });
    expect(invoke).not.toThrow();
    expect(invoke()).toEqual([]);
  });

  test("does not throw for negative signal values and returns empty array", () => {
    const invoke = () =>
      retrieveKnowledge({
        signals: makeSignals({ functionCount: -1, hookCount: -1 }),
        fileExtension: ".ts",
        classifications: [],
      });
    expect(invoke).not.toThrow();
    expect(invoke()).toEqual([]);
  });

  test("does not throw for very large signal values and caps results", () => {
    const invoke = () =>
      retrieveKnowledge({
        signals: makeSignals({ functionCount: 1e9 }),
        fileExtension: ".ts",
        classifications: [],
      });
    expect(invoke).not.toThrow();
    const result = invoke();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  test("does not throw for NaN signal values and returns empty array", () => {
    const invoke = () =>
      retrieveKnowledge({
        signals: makeSignals({ functionCount: NaN }),
        fileExtension: ".ts",
        classifications: [],
      });
    expect(invoke).not.toThrow();
    expect(invoke()).toEqual([]);
  });

  test("does not throw for non-integer float signal values", () => {
    const invoke = () =>
      retrieveKnowledge({
        signals: makeSignals({ functionCount: 2.5 }),
        fileExtension: ".ts",
        classifications: [],
      });
    expect(invoke).not.toThrow();
    expect(Array.isArray(invoke())).toBe(true);
  });

  test("retrieves nested-conditionals doc for high_nesting signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxNestingDepth: 5 }),
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

  test("retrieves dependency-inversion doc for hardcoded-dependency classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["hardcoded-dependency"],
    });
    expect(result.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("retrieves long-parameter-list doc for high_param_count signal", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ maxParameterCount: 6 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("retrieves prop-drilling doc only for tsx/jsx files", () => {
    const tsxResult = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".tsx",
      classifications: ["prop-drilling"],
    });
    expect(tsxResult.some((doc) => doc.id === "prop-drilling")).toBe(true);

    const tsResult = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["prop-drilling"],
    });
    expect(tsResult.some((doc) => doc.id === "prop-drilling")).toBe(false);
  });

  test("retrieves strategy-dispatch doc for switch-chain classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["switch-chain"],
    });
    expect(result.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("retrieves side-effects-purity doc for query-side-effect classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["query-side-effect"],
    });
    expect(result.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("retrieves interface-segregation doc for fat-interface classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["fat-interface"],
    });
    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("retrieves copy-paste-duplication doc for duplication classification", () => {
    const result = retrieveKnowledge({
      signals: makeSignals(),
      fileExtension: ".ts",
      classifications: ["duplication"],
    });
    expect(result.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("retrieves interface-segregation doc for has_classes and has_type_assertions signals", () => {
    const result = retrieveKnowledge({
      signals: makeSignals({ classCount: 3, typeAssertionCount: 2 }),
      fileExtension: ".ts",
      classifications: [],
    });
    expect(result.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });
});
