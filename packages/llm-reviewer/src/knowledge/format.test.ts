import { describe, expect, test } from "bun:test";
import type { KnowledgeDocument } from "../pipeline-types";
import { formatKnowledgeSection } from "./format";

function makeDocument(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "test-doc",
    title: "Test Document",
    category: "clean",
    triggerSignals: [],
    triggerClassifications: [],
    fileExtensions: [],
    content: "Test content about code quality.",
    examples: [],
    ...overrides,
  };
}

describe("formatKnowledgeSection", () => {
  test("returns empty string for empty documents", () => {
    expect(formatKnowledgeSection([])).toBe("");
  });

  test("formats a single document with title and content", () => {
    const result = formatKnowledgeSection([makeDocument()]);
    expect(result).toContain("## Relevant patterns and principles");
    expect(result).toContain("### Test Document");
    expect(result).toContain("Test content about code quality.");
  });

  test("formats examples within a document", () => {
    const result = formatKnowledgeSection([
      makeDocument({
        examples: [
          {
            label: "Bad naming",
            scenario: "Variable named x instead of userCount",
            bad: "const x = users.length;",
            good: "const userCount = users.length;",
            explanation: "Descriptive names reduce cognitive load.",
          },
        ],
      }),
    ]);

    expect(result).toContain("#### Bad naming");
    expect(result).toContain("const x = users.length;");
    expect(result).toContain("const userCount = users.length;");
    expect(result).toContain("Descriptive names reduce cognitive load.");
  });

  test("includes multiple documents when under character cap", () => {
    const documents = [
      makeDocument({ id: "doc-1", title: "First" }),
      makeDocument({ id: "doc-2", title: "Second" }),
    ];

    const result = formatKnowledgeSection(documents);
    expect(result).toContain("### First");
    expect(result).toContain("### Second");
  });

  test("truncates when exceeding character cap", () => {
    const longContent = "x".repeat(7950);
    const documents = [
      makeDocument({ id: "doc-1", title: "First", content: longContent }),
      makeDocument({ id: "doc-2", title: "Second", content: "Short content" }),
    ];

    const result = formatKnowledgeSection(documents);
    expect(result).toContain("### First");
    expect(result).not.toContain("### Second");
  });
});
