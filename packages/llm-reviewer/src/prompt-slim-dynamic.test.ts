import { describe, expect, test } from "bun:test";
import type { FileDiff } from "@mergewise/shared-types";
import { toFilePath } from "@mergewise/shared-types";
import type { StructuralSignals } from "./signals";
import type { KnowledgeDocument, FileGraphContext, ReviewLearnings } from "./pipeline-types";
import { buildDynamicFilePrompt } from "./prompt-slim";

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

  test("includes agent-impact evidence note when agentFriendliness and graphContext are both present", () => {
    const graphContext: FileGraphContext = {
      filePath: toFilePath("src/index.ts"),
      callers: [toFilePath("src/app.ts")],
      centrality: 0.9,
      isHotspot: true,
    };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      graphContext,
      agentFriendliness: true,
    });
    expect(result).toContain("caller count, centrality score, and hotspot status");
  });

  test("omits agent-impact evidence note when agentFriendliness is false with graphContext", () => {
    const graphContext: FileGraphContext = {
      filePath: toFilePath("src/index.ts"),
      callers: [toFilePath("src/app.ts")],
      centrality: 0.9,
      isHotspot: true,
    };

    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      graphContext,
      agentFriendliness: false,
    });
    expect(result).not.toContain("caller count, centrality score, and hotspot status");
  });

  test("omits agent-impact evidence note when agentFriendliness is true but no graphContext", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      agentFriendliness: true,
    });
    expect(result).not.toContain("caller count, centrality score, and hotspot status");
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

  test("includes PR context section when prTitle is provided", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      prTitle: "fix: replace streams with sync reads",
      prDescription: "Streams hang in Bun.",
    });
    expect(result).toContain("## Pull Request Context");
    expect(result).toContain("Title: fix: replace streams with sync reads");
    expect(result).toContain("Description: Streams hang in Bun.");
    expect(result).toContain("do not suggest reverting");
  });

  test("omits PR context section when prTitle is absent", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
    });
    expect(result).not.toContain("## Pull Request Context");
  });

  test("omits description line when prDescription is absent", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      prTitle: "fix: something",
    });
    expect(result).toContain("Title: fix: something");
    expect(result).not.toContain("Description:");
  });

  test("truncates prDescription at 500 characters", () => {
    const longDescription = "z".repeat(800);
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      prTitle: "chore: truncation test",
      prDescription: longDescription,
    });
    expect(result).toContain("Description: " + "z".repeat(500));
    expect(result).not.toContain("z".repeat(501));
  });

  test("PR context appears before the diff section", () => {
    const result = buildDynamicFilePrompt({
      fileDiff: makeDiff(),
      fullContent: null,
      signals: makeSignals(),
      knowledge: [],
      prTitle: "feat: new feature",
    });
    const contextIndex = result.indexOf("## Pull Request Context");
    const diffIndex = result.indexOf("## Diff");
    expect(contextIndex).toBeLessThan(diffIndex);
  });
});
