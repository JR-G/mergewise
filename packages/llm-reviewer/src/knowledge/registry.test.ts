import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_REGISTRY } from "./registry";
import type { KnowledgeDocument } from "../pipeline-types";

describe("KNOWLEDGE_REGISTRY", () => {
  test("contains all 12 knowledge documents", () => {
    expect(KNOWLEDGE_REGISTRY.length).toBe(12);
  });

  test("contains god-function knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "god-function")).toBe(true);
  });

  test("contains react-hooks knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "react-hooks")).toBe(true);
  });

  test("contains error-handling knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "error-handling")).toBe(true);
  });

  test("contains type-safety knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "type-safety")).toBe(true);
  });

  test("contains nested-conditionals knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "nested-conditionals")).toBe(true);
  });

  test("contains prop-drilling knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "prop-drilling")).toBe(true);
  });

  test("contains dependency-inversion knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "dependency-inversion")).toBe(true);
  });

  test("contains long-parameter-list knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "long-parameter-list")).toBe(true);
  });

  test("contains copy-paste-duplication knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "copy-paste-duplication")).toBe(true);
  });

  test("contains strategy-dispatch knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "strategy-dispatch")).toBe(true);
  });

  test("contains side-effects-purity knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "side-effects-purity")).toBe(true);
  });

  test("contains interface-segregation knowledge document", () => {
    expect(KNOWLEDGE_REGISTRY.some((doc) => doc.id === "interface-segregation")).toBe(true);
  });

  test("registry is frozen and immutable", () => {
    expect(Object.isFrozen(KNOWLEDGE_REGISTRY)).toBe(true);
  });

  test("all documents have required properties", () => {
    for (const doc of KNOWLEDGE_REGISTRY) {
      expect(doc.id).toBeDefined();
      expect(typeof doc.id).toBe("string");
      expect(doc.title).toBeDefined();
      expect(typeof doc.title).toBe("string");
      expect(doc.category).toBeDefined();
      expect(["clean", "idiomatic", "safety", "perf"]).toContain(doc.category);
      expect(Array.isArray(doc.triggerSignals)).toBe(true);
      expect(Array.isArray(doc.triggerClassifications)).toBe(true);
      expect(Array.isArray(doc.fileExtensions)).toBe(true);
      expect(doc.content).toBeDefined();
      expect(typeof doc.content).toBe("string");
      expect(Array.isArray(doc.examples)).toBe(true);
    }
  });

  test("all documents have unique ids", () => {
    const ids = KNOWLEDGE_REGISTRY.map((doc) => doc.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  test("registry is immutable and cannot be modified", () => {
    const originalLength = KNOWLEDGE_REGISTRY.length;
    expect(() => {
      const mutableRegistry = KNOWLEDGE_REGISTRY as unknown as KnowledgeDocument[];
      mutableRegistry.push({
        id: "test-doc",
        title: "Test",
        category: "clean",
        triggerSignals: [],
        triggerClassifications: [],
        fileExtensions: [],
        content: "test",
        examples: [],
      });
    }).toThrow();
    expect(KNOWLEDGE_REGISTRY.length).toBe(originalLength);
  });

  test("each document has non-empty content", () => {
    for (const doc of KNOWLEDGE_REGISTRY) {
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });
});
