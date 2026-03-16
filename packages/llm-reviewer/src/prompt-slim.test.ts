import { describe, expect, test } from "bun:test";
import type { FileDiff } from "@mergewise/shared-types";
import { toFilePath } from "@mergewise/shared-types";
import type { StructuralSignals } from "./signals";
import type { KnowledgeDocument, FileGraphContext, ReviewLearnings } from "./pipeline-types";
import { buildSlimSystemPrompt, buildDynamicFilePrompt } from "./prompt-slim";

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

function makeDiff(filePath = "src/index.ts"): FileDiff {
  return {
    filePath: toFilePath(filePath),
    previousPath: null,
    hunks: [
      {
        header: "@@ -1,3 +1,5 @@",
        lines: [
          " const a = 1;",
          "+const b = 2;",
          "+const c = 3;",
          " const d = 4;",
        ],
      },
    ],
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
    content: "Test content about code patterns.",
    examples: [],
    ...overrides,
  };
}

describe("buildSlimSystemPrompt", () => {
  const prompt = buildSlimSystemPrompt();

  test("covers TypeScript and React focus areas", () => {
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("React");
  });

  test("contains principal-level persona", () => {
    expect(prompt).toContain("principal-level");
  });

  test("specifies JSON output format", () => {
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"line"');
    expect(prompt).toContain('"category"');
    expect(prompt).toContain('"confidence"');
  });

  test("does not impose finding caps", () => {
    expect(prompt).not.toContain("max 8");
    expect(prompt).not.toContain("maximum of");
  });

  test("contains anti-instructions against defensive coding noise", () => {
    expect(prompt).toContain("Anti-instructions");
    expect(prompt).toContain("Do NOT suggest adding null checks");
    expect(prompt).toContain("Do NOT act as a linter, bug finder, or security scanner");
    expect(prompt).toContain("Do NOT suggest error handling additions unless");
  });
});

describe("buildDynamicFilePrompt", () => {
  test("includes diff content", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).toContain("```diff");
    expect(result).toContain("+const b = 2;");
  });

  test("includes file path header", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff("src/components/Dashboard.tsx"),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).toContain("## File: src/components/Dashboard.tsx");
  });

  test("includes knowledge section when documents are provided", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [makeDocument({ title: "God Function Detection" })],
    });
    expect(result).toContain("## Relevant patterns and principles");
    expect(result).toContain("### God Function Detection");
  });

  test("omits knowledge section when no documents", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).not.toContain("## Relevant patterns and principles");
  });

  test("includes graph context when provided", () => {
    const graphContext: FileGraphContext = {
      filePath: toFilePath("src/index.ts"),
      callers: [toFilePath("src/app.ts"), toFilePath("src/main.ts")],
      centrality: 0.85,
      isHotspot: true,
    };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      graphContext,
    });
    expect(result).toContain("## Codebase context");
    expect(result).toContain("src/app.ts");
    expect(result).toContain("change hotspot");
  });

  test("omits graph context when undefined", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).not.toContain("## Codebase context");
  });

  test("includes learnings when provided", () => {
    const learnings: ReviewLearnings = {
      preferences: ["Prefer composition over inheritance", "Use named exports"],
    };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      learnings,
    });
    expect(result).toContain("## Repository preferences");
    expect(result).toContain("Prefer composition over inheritance");
  });

  test("omits learnings when empty", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      learnings: { preferences: [] },
    });
    expect(result).not.toContain("## Repository preferences");
  });

  test("includes structural signals when non-zero", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals({ hookCount: 3, functionCount: 7 }),
      knowledge: [],
    });
    expect(result).toContain("## Structural signals");
    expect(result).toContain("Hook calls");
    expect(result).toContain("Function/method count: 7");
  });

  test("omits structural signals section when all zero", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).not.toContain("## Structural signals");
  });

  test("includes file context when fullContent is provided", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n",
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).toContain("// line 1: const a = 1;");
  });

  test("truncates callers list beyond MAX_CALLERS_IN_PROMPT", () => {
    const callers = Array.from({ length: 15 }, (_, index) => toFilePath(`caller-${index}`));
    const graphContext: FileGraphContext = {
      filePath: toFilePath("src/index.ts"),
      callers,
      centrality: 0.5,
      isHotspot: false,
    };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      graphContext,
    });
    expect(result).toContain("caller-9");
    expect(result).not.toContain("caller-10");
  });

  test("truncates learnings beyond MAX_LEARNINGS_IN_PROMPT", () => {
    const preferences = Array.from({ length: 8 }, (_, index) => `pref-${index}`);
    const learnings: ReviewLearnings = { preferences };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      learnings,
    });
    expect(result).toContain("pref-4");
    expect(result).not.toContain("pref-5");
  });

  test("truncates full file content beyond MAX_FULL_FILE_LINES", () => {
    const fullContent = Array.from({ length: 2500 }, (_, index) => `line content ${index}`).join("\n");
    const largeDiff: FileDiff = {
      filePath: toFilePath("src/big.ts"),
      previousPath: null,
      hunks: [
        {
          header: "@@ -1,2500 +1,2500 @@",
          lines: ["+changed line"],
        },
      ],
    };

    const result = buildDynamicFilePrompt({
      fileDiff: largeDiff,
      fullContent,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).toContain("// line 2000:");
    expect(result).not.toContain("// line 2001:");
    expect(result).toContain("[truncated");
  });
});
