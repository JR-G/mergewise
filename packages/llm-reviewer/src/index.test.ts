import { describe, expect, test } from "bun:test";
import type {
  FileDiff,
  DiffHunk,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import {
  selectFilesForReview,
  extractAddedLineNumbers,
  parseLlmResponse,
  buildSystemPrompt,
  buildFileReviewPrompt,
  extractStructuralSignals,
} from "./index";

function makeHunk(header: string, lines: string[]): DiffHunk {
  return { header, lines };
}

function makeDiff(filePath: string, hunks: DiffHunk[]): FileDiff {
  return { filePath, previousPath: null, hunks };
}

const PR_METADATA: PullRequestMetadata = {
  repo: "acme/widget",
  prNumber: 42,
  headSha: "abc123",
  installationId: 1,
};

describe("selectFilesForReview", () => {
  test("skips test files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+line1", "+line2", "+line3", "+line4", "+line5"])]),
      makeDiff("src/app.spec.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]),
      makeDiff("__tests__/util.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+x", "+y"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips config and lockfiles", () => {
    const diffs: FileDiff[] = [
      makeDiff("eslint.config.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("tsconfig.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("package-lock.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("bun.lockb", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips non-TypeScript files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/styles.css", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("README.md", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/data.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("selects TypeScript files sorted by added line count", () => {
    const small = makeDiff("src/small.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]);
    const large = makeDiff("src/large.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+a", "+b", "+c", "+d", "+e"])]);

    const result = selectFilesForReview([small, large], 100_000);
    expect(result).toHaveLength(2);
    expect(result[0]!.filePath).toBe("src/large.ts");
    expect(result[1]!.filePath).toBe("src/small.ts");
  });

  test("prefers tsx over ts at equal change volume", () => {
    const tsFile = makeDiff("src/util.ts", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);
    const tsxFile = makeDiff("src/Component.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);

    const result = selectFilesForReview([tsFile, tsxFile], 100_000);
    expect(result[0]!.filePath).toBe("src/Component.tsx");
  });

  test("respects token budget", () => {
    const file1 = makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_, idx) => `+line${idx}`))]);
    const file2 = makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_, idx) => `+line${idx}`))]);

    const result = selectFilesForReview([file1, file2], 44);
    expect(result).toHaveLength(1);
  });

  test("always includes at least one file even if it exceeds budget", () => {
    const bigFile = makeDiff("src/big.ts", [makeHunk("@@ -0,0 +1,100 @@", Array.from({ length: 100 }, (_, idx) => `+line${idx}`))]);

    const result = selectFilesForReview([bigFile], 10);
    expect(result).toHaveLength(1);
  });
});

describe("extractAddedLineNumbers", () => {
  test("extracts added line numbers from hunks", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,3 +1,5 @@", [
        " existing",
        "+added1",
        "+added2",
        " existing2",
        "+added3",
      ]),
    ]);

    const result = extractAddedLineNumbers(diff);
    expect(result).toEqual(new Set([2, 3, 5]));
  });

  test("skips deleted lines in line counting", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,4 +1,3 @@", [
        " keep",
        "-removed",
        "+added",
        " keep2",
      ]),
    ]);

    const result = extractAddedLineNumbers(diff);
    expect(result).toEqual(new Set([2]));
  });
});

describe("parseLlmResponse", () => {
  const diff = makeDiff("src/file.ts", [
    makeHunk("@@ -1,3 +1,5 @@", [
      " existing",
      "+added line 2",
      "+added line 3",
      " existing2",
      "+added line 5",
    ]),
  ]);

  test("parses valid JSON response", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "idiomatic",
          confidence: 0.85,
          evidence: "const data = fetchData()",
          recommendation: "Rename 'data' to reflect what it contains.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(2);
    expect(result[0]!.category).toBe("idiomatic");
    expect(result[0]!.confidence).toBe(0.85);
    expect(result[0]!.ruleId).toBe("llm/reviewer");
    expect(result[0]!.patchSuggestionPolicy).toBe("manual-only");
    expect(result[0]!.status).toBe("posted");
  });

  test("discards findings on non-added lines", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "existing code",
          recommendation: "Refactor this.",
        },
        {
          line: 99,
          category: "clean",
          confidence: 0.9,
          evidence: "hallucinated line",
          recommendation: "Does not exist.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("discards findings with invalid category", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "style",
          confidence: 0.9,
          evidence: "code",
          recommendation: "Fix it.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("discards findings with out-of-range confidence", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 1.5,
          evidence: "code",
          recommendation: "Fix it.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for malformed JSON", () => {
    const result = parseLlmResponse("not json at all", diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for missing findings key", () => {
    const result = parseLlmResponse('{"comments": []}', diff, PR_METADATA);
    expect(result).toHaveLength(0);
  });

  test("generates correct findingId", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 3,
          category: "safety",
          confidence: 0.92,
          evidence: "unsafe cast",
          recommendation: "Remove the type assertion.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PR_METADATA);
    expect(result[0]!.findingId).toBe("llm/reviewer:acme/widget:42:src/file.ts:3");
  });
});

describe("buildSystemPrompt", () => {
  test("includes key review focus areas", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SOLID");
    expect(prompt).toContain("DRY");
    expect(prompt).toContain("KISS");
    expect(prompt).toContain("AI slop");
    expect(prompt).toContain("Naming quality");
  });

  test("excludes lint/formatting concerns", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("What NOT to flag");
    expect(prompt).toContain("Formatting");
  });
});

describe("buildFileReviewPrompt", () => {
  test("includes diff content and file path", () => {
    const diff = makeDiff("src/app.tsx", [
      makeHunk("@@ -1,2 +1,3 @@", [" import React", "+const App = () => {", "+}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, {
      componentLineCount: 0,
      hookCount: 0,
      importCount: 0,
      maxNestingDepth: 0,
    });

    expect(prompt).toContain("src/app.tsx");
    expect(prompt).toContain("const App = () => {");
  });

  test("includes full file content when provided", () => {
    const diff = makeDiff("src/util.ts", [
      makeHunk("@@ -1,1 +1,2 @@", [" export function foo() {}", "+export function bar() {}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, "full file content here", {
      componentLineCount: 0,
      hookCount: 0,
      importCount: 0,
      maxNestingDepth: 0,
    });

    expect(prompt).toContain("full file content here");
    expect(prompt).toContain("Full file content");
  });

  test("includes structural signals when non-zero", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -1,1 +1,2 @@", ["+const x = 1"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, {
      componentLineCount: 150,
      hookCount: 8,
      importCount: 12,
      maxNestingDepth: 4,
    });

    expect(prompt).toContain("Component line count: 150");
    expect(prompt).toContain("useState/useEffect calls: 8");
    expect(prompt).toContain("Import statements: 12");
    expect(prompt).toContain("Max callback/promise nesting depth: 4");
  });
});

describe("extractStructuralSignals", () => {
  test("counts hook calls", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+const [x, setX] = useState(0)",
        "+useEffect(() => {}, [])",
        "+const ref = useRef(null)",
        "+const memo = useMemo(() => x, [x])",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.hookCount).toBe(4);
  });

  test("counts import statements", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+import React from 'react'",
        "+import { useState } from 'react'",
        "+const x = 1",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.importCount).toBe(2);
  });

  test("tracks nesting depth", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,5 @@", [
        "+function outer() {",
        "+  if (true) {",
        "+    callback(() => {",
        "+    })",
        "+  }",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxNestingDepth).toBeGreaterThanOrEqual(3);
  });
});
