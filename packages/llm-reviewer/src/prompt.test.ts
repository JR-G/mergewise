import { describe, expect, test } from "bun:test";
import type { DiffHunk, FileDiff } from "@mergewise/shared-types";
import { toFilePath } from "@mergewise/shared-types";

import { buildFileReviewPrompt, buildSystemPrompt, computeContextWindows } from "./prompt";

describe("buildSystemPrompt", () => {
  test("does not contain the problematic structural suggestion rewrite clause", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("extracted function signatures or the refactored shape");
  });

  test("constrains suggestedRewrite to localised fixes and excludes structural rewrites", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("drop-in fix");
    expect(prompt).toContain("structural suggestions");
    expect(prompt).toContain("recommendation field");
  });

  test("scopes React-specific suggestions to React files only", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("only apply to .tsx/.jsx files");
    expect(prompt).toContain("Never suggest React APIs");
  });

  test("instructs LLM to never flag non-code content", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Non-code content");
    expect(prompt).toContain("string literals");
    expect(prompt).toContain("not a code issue");
  });

  test("instructs LLM to respect documented design decisions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Documented design decisions");
    expect(prompt).toContain("documented rationale");
  });

  test("frames anti-pattern catalogue as a recognition aid", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("recognition aid");
    expect(prompt).toContain("confirm");
    expect(prompt).not.toContain("Use this table to recognise");
  });

  test("includes multi-finding breadth example (Example H)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Example H");
    expect(prompt).toContain("StatusDashboard");
  });

  test("includes switch-on-type pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("switch-on-type");
    expect(prompt).toContain(
      "switch or if-else chain with 4+ branches dispatching on a .type, .kind, or string-literal discriminator",
    );
  });

  test("includes manual-object-construction pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("manual-object-construction");
    expect(prompt).toContain(
      "3+ object literals with the same set of keys constructed in the same scope",
    );
  });

  test("includes scattered-event-handling pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("scattered-event-handling");
    expect(prompt).toContain(
      ".on(), .addEventListener(), or .subscribe() calls on the same target scattered across a function body",
    );
  });

  test("does not use SRP as a parenthetical suffix in positive examples", () => {
    const prompt = buildSystemPrompt();
    const correctOutputSections = prompt.split("Correct output:").slice(1);
    for (const section of correctOutputSections) {
      const jsonPart = section.split("`")[1] ?? "";
      expect(jsonPart).not.toContain("(SRP)");
    }
  });

  test("requires concrete engineering cost in recommendation spec", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("concrete engineering cost");
    expect(prompt).toContain("explain the cost first");
  });

  test("includes negative few-shot examples for orchestrators and helpers", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Negative examples");
    expect(prompt).toContain("orchestrator function (correct output is empty)");
    expect(prompt).toContain("already-extracted helper (correct output is empty)");
    expect(prompt).toContain("module-level constants (correct output is empty)");
  });

  test("includes anti-instructions for orchestrator and wrapper patterns", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("orchestrator, pipeline, or coordinator");
    expect(prompt).toContain("already the extracted helper");
    expect(prompt).toContain("module-level constants");
    expect(prompt).toContain("runInTransaction");
    expect(prompt).toContain("generic \"split this function\"");
  });

  test("bad findings include SRP-as-suffix and orchestrator misapplication", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("cites a principle without explaining the concrete cost");
    expect(prompt).toContain("Orchestration is one responsibility");
  });

  test("output format requires principle field", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"principle"');
    expect(prompt).toContain("named anti-pattern or design principle");
  });

  test("few-shot examples include principle field", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"principle": "SRP"');
    expect(prompt).toContain('"principle": "DIP"');
    expect(prompt).toContain('"principle": "LSP"');
    expect(prompt).toContain('"principle": "derive-dont-sync"');
  });

  test("includes principle-to-category mapping guidance", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("category MUST match the principle");
  });

});

function makeHunk(header: string, lines: string[] = []): DiffHunk {
  return { header, lines };
}

function makeFileContent(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${index + 1} content`).join("\n");
}

describe("computeContextWindows", () => {
  test("single hunk produces a padded window clamped to file bounds", () => {
    const hunks = [makeHunk("@@ -100,5 +100,7 @@")];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([{ start: 50, end: 156 }]);
  });

  test("clamps window start to line 1", () => {
    const hunks = [makeHunk("@@ -1,3 +1,5 @@")];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([{ start: 1, end: 55 }]);
  });

  test("clamps window end to total lines", () => {
    const hunks = [makeHunk("@@ -490,5 +490,5 @@")];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([{ start: 440, end: 500 }]);
  });

  test("merges overlapping windows from adjacent hunks", () => {
    const hunks = [
      makeHunk("@@ -10,3 +10,3 @@"),
      makeHunk("@@ -50,3 +50,3 @@"),
    ];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([{ start: 1, end: 102 }]);
  });

  test("keeps non-overlapping windows separate", () => {
    const hunks = [
      makeHunk("@@ -10,3 +10,3 @@"),
      makeHunk("@@ -200,3 +200,3 @@"),
    ];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([
      { start: 1, end: 62 },
      { start: 150, end: 252 },
    ]);
  });

  test("handles hunk header with no count (single-line change)", () => {
    const hunks = [makeHunk("@@ -100,0 +100 @@")];
    const windows = computeContextWindows(hunks, 500);
    expect(windows).toEqual([{ start: 50, end: 150 }]);
  });

  test("respects custom padding", () => {
    const hunks = [makeHunk("@@ -100,5 +100,5 @@")];
    const windows = computeContextWindows(hunks, 500, 10);
    expect(windows).toEqual([{ start: 90, end: 114 }]);
  });
});

describe("buildFileReviewPrompt context windowing", () => {
  const emptySignals = {
    componentLineCount: 0,
    hookCount: 0,
    importCount: 0,
    maxNestingDepth: 0,
    functionCount: 0,
    maxFunctionLineCount: 0,
    maxParameterCount: 0,
    classCount: 0,
    typeAssertionCount: 0,
  };

  test("large file with a single small hunk produces windowed context", () => {
    const fileContent = makeFileContent(1000);
    const diff: FileDiff = {
      filePath: toFilePath("src/big.ts"),
      previousPath: null,
      hunks: [makeHunk("@@ -500,3 +500,5 @@", ["+added line"])],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: fileContent, signals: emptySignals });

    expect(prompt).toContain("File context (lines 450");
    expect(prompt).not.toContain("Full file content");
    expect(prompt).toContain("// line 450:");
  });

  test("small file falls back to full file content with line numbers", () => {
    const fileContent = makeFileContent(80);
    const diff: FileDiff = {
      filePath: toFilePath("src/small.ts"),
      previousPath: null,
      hunks: [makeHunk("@@ -1,80 +1,82 @@", ["+added"])],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: fileContent, signals: emptySignals });

    expect(prompt).toContain("Full file content");
    expect(prompt).not.toContain("File context (lines");
    expect(prompt).toContain("// line 1:");
    expect(prompt).toContain("// line 80:");
  });

  test("null fullContent produces no context section", () => {
    const diff: FileDiff = {
      filePath: toFilePath("src/gone.ts"),
      previousPath: null,
      hunks: [makeHunk("@@ -1,3 +1,3 @@", ["+x"])],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: null, signals: emptySignals });

    expect(prompt).not.toContain("File context");
    expect(prompt).not.toContain("Full file content");
  });

  test("malformed hunk headers fall back to full file content", () => {
    const fileContent = makeFileContent(200);
    const diff: FileDiff = {
      filePath: toFilePath("src/broken.ts"),
      previousPath: null,
      hunks: [makeHunk("INVALID HEADER", ["+added"])],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: fileContent, signals: emptySignals });

    expect(prompt).toContain("Full file content");
    expect(prompt).not.toContain("File context (lines");
  });

  test("falls back to full file when windows cover most of the file", () => {
    const fileContent = makeFileContent(10);
    const diff: FileDiff = {
      filePath: toFilePath("src/tiny.ts"),
      previousPath: null,
      hunks: [makeHunk("@@ -1,3 +1,5 @@", ["+added"])],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: fileContent, signals: emptySignals });

    expect(prompt).toContain("Full file content");
    expect(prompt).not.toContain("File context (lines");
  });

  test("uses windowed context when coverage is below threshold", () => {
    const fileContent = makeFileContent(500);
    const diff: FileDiff = {
      filePath: toFilePath("src/medium.ts"),
      previousPath: null,
      hunks: [
        makeHunk("@@ -100,3 +100,5 @@", ["+added"]),
        makeHunk("@@ -300,3 +300,5 @@", ["+added"]),
      ],
    };
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: fileContent, signals: emptySignals });

    expect(prompt).toContain("File context (lines");
    expect(prompt).not.toContain("Full file content");
  });
});

describe("buildFileReviewPrompt PR context", () => {
  const emptySignals = {
    componentLineCount: 0,
    hookCount: 0,
    importCount: 0,
    maxNestingDepth: 0,
    functionCount: 0,
    maxFunctionLineCount: 0,
    maxParameterCount: 0,
    classCount: 0,
    typeAssertionCount: 0,
  };

  const diff: FileDiff = {
    filePath: toFilePath("src/index.ts"),
    previousPath: null,
    hunks: [{ header: "@@ -1,3 +1,5 @@", lines: ["+added"] }],
  };

  test("includes PR context section when title is provided", () => {
    const prompt = buildFileReviewPrompt({
      fileDiff: diff, fullContent: null, signals: emptySignals,
      prTitle: "fix: replace streams with sync reads",
      prDescription: "Streams hang in Bun, switched to readFileSync.",
    });
    expect(prompt).toContain("## Pull Request Context");
    expect(prompt).toContain("Title: fix: replace streams with sync reads");
    expect(prompt).toContain("Description: Streams hang in Bun");
    expect(prompt).toContain("do not suggest reverting");
  });

  test("omits PR context section when title is absent", () => {
    const prompt = buildFileReviewPrompt({ fileDiff: diff, fullContent: null, signals: emptySignals });
    expect(prompt).not.toContain("## Pull Request Context");
  });

  test("omits description line when prDescription is absent", () => {
    const prompt = buildFileReviewPrompt({
      fileDiff: diff, fullContent: null, signals: emptySignals,
      prTitle: "fix: something",
    });
    expect(prompt).toContain("## Pull Request Context");
    expect(prompt).toContain("Title: fix: something");
    expect(prompt).not.toContain("Description:");
  });

  test("truncates prDescription at 500 characters", () => {
    const longDescription = "y".repeat(800);
    const prompt = buildFileReviewPrompt({
      fileDiff: diff, fullContent: null, signals: emptySignals,
      prTitle: "chore: long desc",
      prDescription: longDescription,
    });
    expect(prompt).toContain("Description: " + "y".repeat(500));
    expect(prompt).not.toContain("y".repeat(501));
  });

  test("PR context appears before the diff section", () => {
    const prompt = buildFileReviewPrompt({
      fileDiff: diff, fullContent: null, signals: emptySignals,
      prTitle: "feat: new feature",
      prDescription: "Details here.",
    });
    const contextIndex = prompt.indexOf("## Pull Request Context");
    const diffIndex = prompt.indexOf("## Diff");
    expect(contextIndex).toBeLessThan(diffIndex);
  });
});
