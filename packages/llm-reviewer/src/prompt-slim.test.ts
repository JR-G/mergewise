import { describe, expect, test } from "bun:test";
import type { FileDiff } from "@mergewise/shared-types";
import { toFilePath } from "@mergewise/shared-types";
import type { StructuralSignals } from "./signals";
import { buildSlimSystemPrompt, buildToolUseFilePrompt, MAX_DIFF_CHARS } from "./prompt-slim";

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

  test("includes agent-specific detection criteria when agentFriendliness is true", () => {
    const agentPrompt = buildSlimSystemPrompt({ agentFriendliness: true });
    expect(agentPrompt).toContain("AI agent compatibility");
    expect(agentPrompt).toContain("Context window overflows");
    expect(agentPrompt).toContain("Implicit conventions");
    expect(agentPrompt).toContain("Tangled read/write");
    expect(agentPrompt).toContain("Missing interfaces");
    expect(agentPrompt).toContain("Distributed state mutations");
  });

  test("omits agent criteria when agentFriendliness is false", () => {
    const standardPrompt = buildSlimSystemPrompt({ agentFriendliness: false });
    expect(standardPrompt).not.toContain("AI agent compatibility");
  });

  test("omits agent criteria when options are omitted", () => {
    const standardPrompt = buildSlimSystemPrompt();
    expect(standardPrompt).not.toContain("AI agent compatibility");
  });
});

describe("buildSlimSystemPrompt with toolUse option", () => {
  test("includes available tools section when toolUse is true", () => {
    const prompt = buildSlimSystemPrompt({ toolUse: true });
    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("read_file_section");
    expect(prompt).toContain("get_callers");
    expect(prompt).toContain("lookup_pattern");
    expect(prompt).toContain("get_repo_preferences");
  });

  test("omits available tools section when toolUse is false", () => {
    const prompt = buildSlimSystemPrompt({ toolUse: false });
    expect(prompt).not.toContain("## Available tools");
  });

  test("omits available tools section when toolUse is omitted", () => {
    const prompt = buildSlimSystemPrompt();
    expect(prompt).not.toContain("## Available tools");
  });

  test("combines agentFriendliness and toolUse addenda", () => {
    const prompt = buildSlimSystemPrompt({ agentFriendliness: true, toolUse: true });
    expect(prompt).toContain("AI agent compatibility");
    expect(prompt).toContain("## Available tools");
  });
});

describe("buildToolUseFilePrompt", () => {
  test("includes diff content", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "Available patterns for lookup_pattern tool:\n- srp: SRP Violations",
    });
    expect(result).toContain("```diff");
    expect(result).toContain("+const b = 2;");
  });

  test("includes file path header", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff("src/components/App.tsx"),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).toContain("## File: src/components/App.tsx");
  });

  test("includes structural signals when non-zero", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals({ hookCount: 5, functionCount: 3 }),
      availablePatterns: "",
    });
    expect(result).toContain("## Structural signals");
    expect(result).toContain("Hook calls");
    expect(result).toContain("Function/method count: 3");
  });

  test("includes available patterns summary", () => {
    const patterns = "Available patterns for lookup_pattern tool:\n- srp: SRP Violations\n- god-function: God Functions";
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: patterns,
    });
    expect(result).toContain("srp: SRP Violations");
    expect(result).toContain("god-function: God Functions");
  });

  test("excludes full file content", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).not.toContain("## Full file content");
    expect(result).not.toContain("## File context");
  });

  test("excludes knowledge section", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).not.toContain("## Relevant patterns and principles");
  });

  test("excludes graph context", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).not.toContain("## Codebase context");
  });

  test("excludes repository preferences", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).not.toContain("## Repository preferences");
  });

  test("includes PR context when provided", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
      prTitle: "fix: memory leak in worker",
      prDescription: "Worker process hangs after 100 jobs.",
    });
    expect(result).toContain("## Pull Request Context");
    expect(result).toContain("fix: memory leak in worker");
  });

  test("includes instruction to use tools and return JSON", () => {
    const result = buildToolUseFilePrompt({
      fileDiff: makeDiff(),
      signals: makeSignals(),
      availablePatterns: "",
    });
    expect(result).toContain("Use tools if you need more context");
    expect(result).toContain("Return findings as JSON");
  });

  test("truncates diff content exceeding MAX_DIFF_CHARS and bounds total prompt length", () => {
    const oversizedLine = "+" + "x".repeat(10_000);
    const largeDiff: FileDiff = {
      filePath: toFilePath("src/large.ts"),
      previousPath: null,
      hunks: [
        {
          header: "@@ -1,1 +1,6 @@",
          lines: Array.from({ length: 6 }, () => oversizedLine),
        },
      ],
    };

    const result = buildToolUseFilePrompt({
      fileDiff: largeDiff,
      signals: makeSignals(),
      availablePatterns: "",
    });

    expect(result).toContain("(truncated)");
    expect(result.length).toBeLessThan(MAX_DIFF_CHARS + 5000);
  });
});
