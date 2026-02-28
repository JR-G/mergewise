import { describe, expect, test } from "bun:test";
import type {
  CodebaseContext,
  FileDiff,
  DiffHunk,
  Finding,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import {
  ANTI_PATTERNS,
  selectFilesForReview,
  extractAddedLineNumbers,
  extractAddedLineMap,
  parseLlmResponse,
  deduplicateByProximity,
  buildSystemPrompt,
  buildFileReviewPrompt,
  extractStructuralSignals,
  createLlmReviewerRule,
  createReviewClient,
  isCommentLine,
} from "./index";
import type { AntiPattern } from "./index";
import { reviewFile } from "./review-file";

function makeHunk(header: string, lines: string[]): DiffHunk {
  return { header, lines };
}

function makeDiff(filePath: string, hunks: DiffHunk[]): FileDiff {
  return { filePath, previousPath: null, hunks };
}

const PULL_REQUEST_METADATA: PullRequestMetadata = {
  repo: "acme/widget",
  prNumber: 42,
  headSha: "abc123",
  installationId: 1,
};

function makeMockCodebaseContext(files: Record<string, string> = {}): CodebaseContext {
  return {
    symbols: [],
    conventions: new Map(),
    readFile: async (path: string) => files[path] ?? null,
  };
}

async function withMockFetch(
  handler: (request: Request) => Promise<Response> | Response,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const mockFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const requestInput = input instanceof URL ? input.toString() : input;
    const request = requestInput instanceof Request
      ? requestInput
      : new Request(requestInput, init);
    return await handler(request);
  };
  const patchedFetch = Object.assign(mockFetch, originalFetch);
  globalThis.fetch = patchedFetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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
    const file1 = makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_unused, index) => `+line${index}`))]);
    const file2 = makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_unused, index) => `+line${index}`))]);

    const result = selectFilesForReview([file1, file2], 44);
    expect(result).toHaveLength(1);
  });

  test("always includes at least one file even if it exceeds budget", () => {
    const bigFile = makeDiff("src/big.ts", [makeHunk("@@ -0,0 +1,100 @@", Array.from({ length: 100 }, (_unused, index) => `+line${index}`))]);

    const result = selectFilesForReview([bigFile], 10);
    expect(result).toHaveLength(1);
  });

  test("user skip patterns exclude matching files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/generated/types.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/app.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, ["src/generated/**"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/app.ts");
  });

  test("built-in skip patterns still apply alongside user patterns", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("packages/legacy/util.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/index.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, ["packages/legacy/**"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe("src/index.ts");
  });

  test("empty user skip patterns array has no effect", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, []);
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

describe("extractAddedLineMap", () => {
  test("returns content and hunk headers for added lines", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,3 +1,5 @@", [
        " existing",
        "+added1",
        "+added2",
        " existing2",
        "+added3",
      ]),
    ]);

    const result = extractAddedLineMap(diff);
    expect(result.get(2)).toEqual({ content: "added1", hunkHeader: "@@ -1,3 +1,5 @@" });
    expect(result.get(3)).toEqual({ content: "added2", hunkHeader: "@@ -1,3 +1,5 @@" });
    expect(result.get(5)).toEqual({ content: "added3", hunkHeader: "@@ -1,3 +1,5 @@" });
    expect(result.has(1)).toBe(false);
    expect(result.has(4)).toBe(false);
  });

  test("handles multiple hunks with different headers", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,2 +1,3 @@", [" line1", "+addedA", " line3"]),
      makeHunk("@@ -10,2 +11,3 @@", [" line10", "+addedB", " line12"]),
    ]);

    const result = extractAddedLineMap(diff);
    expect(result.get(2)?.hunkHeader).toBe("@@ -1,2 +1,3 @@");
    expect(result.get(12)?.hunkHeader).toBe("@@ -10,2 +11,3 @@");
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

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(2);
    expect(result[0]!.category).toBe("idiomatic");
    expect(result[0]!.confidence).toBe(0.85);
    expect(result[0]!.ruleId).toBe("llm/reviewer");
    expect(result[0]!.patchSuggestionPolicy).toBeUndefined();
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

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
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

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
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

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for malformed JSON", () => {
    const result = parseLlmResponse("not json at all", diff, PULL_REQUEST_METADATA);
    expect(result).toHaveLength(0);
  });

  test("returns empty array for missing findings key", () => {
    const result = parseLlmResponse('{"comments": []}', diff, PULL_REQUEST_METADATA);
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

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result[0]!.findingId).toBe("llm/reviewer:acme/widget:42:src/file.ts:3:safety");
  });

  test("creates patchPreview when suggestedRewrite is present", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.9,
          evidence: "added line 2",
          recommendation: "Rename variable.",
          suggestedRewrite: "const userData = fetchUser()",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result[0]!.patchPreview).toEqual({
      removedLines: ["added line 2"],
      addedLines: ["const userData = fetchUser()"],
      hunkHeader: "@@ -1,3 +1,5 @@",
    });
  });

  test("omits patchPreview when suggestedRewrite is absent", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.9,
          evidence: "added line 2",
          recommendation: "Rename variable.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result[0]!.patchPreview).toBeUndefined();
  });

  test("omits patchPreview when target line is a comment", () => {
    const commentDiff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,1 +1,3 @@", [
        " existing",
        "+  /** User email, null if unverified */",
        "+  email: string | null;",
      ]),
    ]);

    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "safety",
          confidence: 0.9,
          evidence: "/** User email, null if unverified */",
          recommendation: "Pick one absent-value convention.",
          suggestedRewrite: "  email: string | null;",
        },
      ],
    });

    const result = parseLlmResponse(raw, commentDiff, PULL_REQUEST_METADATA);
    const finding = result.find((item) => item.line === 2 && item.category === "safety");
    expect(finding).toBeDefined();
    expect(finding!.patchPreview).toBeUndefined();
  });

  test("omits patchPreview when target line is a string literal", () => {
    const stringDiff = makeDiff("src/file.ts", [
      makeHunk("@@ -1,1 +1,3 @@", [
        " existing",
        '+      "Same interface using both | null and ? for fields representing no value.",',
        "+  email: string | null;",
      ]),
    ]);

    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "safety",
          confidence: 0.9,
          evidence: '"Same interface using both | null and ?"',
          recommendation: "Pick one absent-value convention.",
          suggestedRewrite: "  email: string | null;",
        },
      ],
    });

    const result = parseLlmResponse(raw, stringDiff, PULL_REQUEST_METADATA);
    const finding = result.find((item) => item.line === 2 && item.category === "safety");
    expect(finding).toBeDefined();
    expect(finding!.patchPreview).toBeUndefined();
  });

  test("preserves patchPreview when target line is actual code", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.9,
          evidence: "added line 2",
          recommendation: "Rename variable.",
          suggestedRewrite: "const userData = fetchUser()",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    const finding = result.find((item) => item.line === 2 && item.category === "clean");
    expect(finding).toBeDefined();
    expect(finding!.patchPreview).toBeDefined();
  });

  test("splits multi-line suggestedRewrite into addedLines", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.9,
          evidence: "added line 2",
          recommendation: "Extract function.",
          suggestedRewrite: "function fetchUser() {\n  return api.get('/user')\n}",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result[0]!.patchPreview?.addedLines).toEqual([
      "function fetchUser() {",
      "  return api.get('/user')",
      "}",
    ]);
    expect(result[0]!.patchPreview?.removedLines).toEqual(["added line 2"]);
  });

  test("filters findings below custom confidence threshold", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.75,
          evidence: "low confidence",
          recommendation: "Maybe fix.",
        },
        {
          line: 3,
          category: "idiomatic",
          confidence: 0.9,
          evidence: "high confidence",
          recommendation: "Definitely fix.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA, 0.8);
    expect(result).toHaveLength(1);
    expect(result[0]!.confidence).toBe(0.9);
  });

  test("retains all findings when no confidence threshold is provided", () => {
    const raw = JSON.stringify({
      findings: [
        {
          line: 2,
          category: "clean",
          confidence: 0.1,
          evidence: "very low",
          recommendation: "Fix.",
        },
        {
          line: 3,
          category: "idiomatic",
          confidence: 0.9,
          evidence: "high",
          recommendation: "Fix.",
        },
      ],
    });

    const result = parseLlmResponse(raw, diff, PULL_REQUEST_METADATA);
    expect(result).toHaveLength(2);
  });
});

describe("isCommentLine", () => {
  test("detects single-line comments", () => {
    expect(isCommentLine("// this is a comment")).toBe(true);
    expect(isCommentLine("  // indented comment")).toBe(true);
  });

  test("detects block comment start", () => {
    expect(isCommentLine("/* block comment */")).toBe(true);
    expect(isCommentLine("  /* indented */")).toBe(true);
  });

  test("detects TSDoc/JSDoc lines", () => {
    expect(isCommentLine("/** TSDoc start */")).toBe(true);
    expect(isCommentLine(" * continuation line")).toBe(true);
    expect(isCommentLine(" */")).toBe(true);
  });

  test("does not match code lines", () => {
    expect(isCommentLine("const x = 1;")).toBe(false);
    expect(isCommentLine("  return value;")).toBe(false);
    expect(isCommentLine("export function foo() {")).toBe(false);
  });

  test("does not match lines with trailing comments", () => {
    expect(isCommentLine("const x = 1; // inline")).toBe(false);
  });
});


function makeFinding(overrides: Partial<Finding> & Pick<Finding, "line" | "category" | "confidence">): Finding {
  return {
    findingId: `test:${overrides.line}:${overrides.category}`,
    installationId: 1,
    repo: "acme/widget",
    prNumber: 42,
    language: "typescript",
    ruleId: "llm/reviewer",
    filePath: "src/file.ts",
    evidence: "some code",
    recommendation: "fix it",
    status: "posted",
    ...overrides,
  };
}

describe("deduplicateByProximity", () => {
  test("collapses findings within proximity into highest-confidence winner", () => {
    const findings = [
      makeFinding({ line: 4, category: "clean", confidence: 0.85 }),
      makeFinding({ line: 5, category: "clean", confidence: 0.80 }),
      makeFinding({ line: 8, category: "clean", confidence: 0.75 }),
    ];

    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(4);
    expect(result[0]!.confidence).toBe(0.85);
  });

  test("preserves findings from different clusters", () => {
    const findings = [
      makeFinding({ line: 2, category: "clean", confidence: 0.85 }),
      makeFinding({ line: 20, category: "clean", confidence: 0.80 }),
    ];

    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(2);
  });

  test("preserves findings in same cluster with different categories", () => {
    const findings = [
      makeFinding({ line: 3, category: "clean", confidence: 0.85 }),
      makeFinding({ line: 5, category: "perf", confidence: 0.80 }),
    ];

    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(2);
  });

  test("caps output at 8 findings", () => {
    const findings = Array.from({ length: 12 }, (_, idx) =>
      makeFinding({ line: (idx + 1) * 10, category: "clean", confidence: 0.9 - idx * 0.01 }),
    );

    const result = deduplicateByProximity(findings);
    expect(result).toHaveLength(8);
    expect(result[0]!.confidence).toBe(0.9);
  });

  test("returns empty array for empty input", () => {
    expect(deduplicateByProximity([])).toHaveLength(0);
  });
});

describe("buildSystemPrompt", () => {
  test("includes key review focus areas", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Responsibility & structure");
    expect(prompt).toContain("SRP");
    expect(prompt).toContain("Design patterns & composition");
    expect(prompt).toContain("Duplication & abstraction");
    expect(prompt).toContain("DRY");
    expect(prompt).toContain("Naming & readability");
    expect(prompt).toContain("Idiomatic TypeScript/React");
    expect(prompt).toContain("AI slop");
    expect(prompt).toContain("Complexity");
  });

  test("frames findings as refactoring suggestions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("refactoring suggestions");
    expect(prompt).toContain("Name the principle");
  });

  test("sets recommendation max to 500 chars", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Max 500 chars");
  });

  test("excludes lint/formatting concerns", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("What NOT to flag");
    expect(prompt).toContain("Formatting");
  });

  test("omits anti-pattern section when patterns array is empty", () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).not.toContain("Anti-pattern reference");
  });

  test("includes pattern id and detectionHint for a single pattern", () => {
    const single: AntiPattern = {
      id: "test-pattern",
      title: "Test Pattern",
      description: "A test pattern.",
      category: "clean",
      languages: ["typescript"],
      badExample: "bad()",
      goodExample: "good()",
      principle: "Test principle",
      detectionHint: "Look for test-pattern-hint in the diff.",
    };
    const prompt = buildSystemPrompt([single]);
    expect(prompt).toContain("Anti-pattern reference");
    expect(prompt).toContain("test-pattern");
    expect(prompt).toContain("Look for test-pattern-hint in the diff.");
  });

  test("default catalogue includes known pattern IDs", () => {
    const prompt = buildSystemPrompt();
    const sampleIds = ANTI_PATTERNS.slice(0, 3).map((pattern) => pattern.id);
    for (const id of sampleIds) {
      expect(prompt).toContain(id);
    }
  });

  test("each catalogue pattern's detectionHint appears in default prompt", () => {
    const prompt = buildSystemPrompt();
    for (const pattern of ANTI_PATTERNS) {
      const escaped = pattern.detectionHint.replaceAll("|", "\\|");
      expect(prompt).toContain(escaped);
    }
  });

  test("includes suggestedRewrite in output format", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("suggestedRewrite");
    expect(prompt).toContain("replacement code for the line");
  });

  test("includes backtick instruction in recommendation bullet", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Wrap code identifiers");
    expect(prompt).toContain("in backticks");
  });

  test("default catalogue does not include badExample/goodExample in prompt", () => {
    const prompt = buildSystemPrompt();
    for (const pattern of ANTI_PATTERNS) {
      expect(prompt).not.toContain(pattern.badExample);
      expect(prompt).not.toContain(pattern.goodExample);
    }
  });
});

const EMPTY_SIGNALS = {
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

describe("buildFileReviewPrompt", () => {
  test("includes diff content and file path", () => {
    const diff = makeDiff("src/app.tsx", [
      makeHunk("@@ -1,2 +1,3 @@", [" import React", "+const App = () => {", "+}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, EMPTY_SIGNALS);

    expect(prompt).toContain("src/app.tsx");
    expect(prompt).toContain("const App = () => {");
  });

  test("includes full file content when provided", () => {
    const diff = makeDiff("src/util.ts", [
      makeHunk("@@ -1,1 +1,2 @@", [" export function foo() {}", "+export function bar() {}"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, "full file content here", EMPTY_SIGNALS);

    expect(prompt).toContain("full file content here");
    expect(prompt).toContain("Full file content");
  });

  test("includes structural signals when non-zero", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -1,1 +1,2 @@", ["+const x = 1"]),
    ]);

    const prompt = buildFileReviewPrompt(diff, null, {
      ...EMPTY_SIGNALS,
      componentLineCount: 150,
      hookCount: 8,
      importCount: 12,
      maxNestingDepth: 4,
      functionCount: 5,
      maxFunctionLineCount: 60,
      maxParameterCount: 7,
      classCount: 2,
      typeAssertionCount: 3,
    });

    expect(prompt).toContain("Component line count: 150");
    expect(prompt).toContain("useState/useEffect calls: 8");
    expect(prompt).toContain("Import statements: 12");
    expect(prompt).toContain("Max callback/promise nesting depth: 4");
    expect(prompt).toContain("Function/method declarations: 5");
    expect(prompt).toContain("Longest function body (approx lines): 60");
    expect(prompt).toContain("Max parameter count: 7");
    expect(prompt).toContain("Class declarations: 2");
    expect(prompt).toContain("Type assertions (as casts): 3");
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

  test("counts function declarations", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+function alpha() {",
        "+}",
        "+function beta() {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.functionCount).toBe(2);
  });

  test("does not count control-flow blocks as functions", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,6 @@", [
        "+if (flag) {",
        "+  runTask()",
        "+}",
        "+for (const value of values) {",
        "+  consume(value)",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.functionCount).toBe(0);
    expect(signals.maxParameterCount).toBe(0);
  });

  test("tracks max function line count", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,8 @@", [
        "+function short() {",
        "+  return 1",
        "+}",
        "+function long() {",
        "+  const a = 1",
        "+  const b = 2",
        "+  return a + b",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxFunctionLineCount).toBeGreaterThanOrEqual(4);
  });

  test("tracks max parameter count", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+function one(a: string) {",
        "+}",
        "+function three(a: string, b: number, c: boolean) {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxParameterCount).toBe(3);
  });

  test("counts class declarations", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+class Foo {",
        "+}",
        "+class Bar {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.classCount).toBe(2);
  });

  test("counts type assertions", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+const x = value as string",
        "+const y = other as number",
        "+const z = 42",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.typeAssertionCount).toBe(2);
  });
});

function buildCompletionResponse(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}

describe("ReviewClient (via fake HTTP server)", () => {
  test("sends correct request structure to OpenAI-compatible endpoint", async () => {
    await withMockFetch(
      async (request) => {
        const requestBody = await request.json() as Record<string, unknown>;
        expect(requestBody.model).toBe("test-model");
        expect(requestBody.temperature).toBe(0.2);
        expect(requestBody.max_completion_tokens).toBe(1024);
        const messages = requestBody.messages as { role: string; content: string }[];
        expect(messages).toHaveLength(2);
        expect(messages[0]!.role).toBe("system");
        expect(messages[0]!.content).toBe("system prompt");
        expect(messages[1]!.role).toBe("user");
        expect(messages[1]!.content).toBe("user prompt");
        return new Response(buildCompletionResponse(JSON.stringify({ findings: [] })), {
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        const client = createReviewClient({
          apiKey: "test-api-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
        });
        await client.complete("system prompt", "user prompt", 1024);
      },
    );
  });

  test("returns parsed content from the LLM response", async () => {
    await withMockFetch(
      () =>
        new Response(buildCompletionResponse(JSON.stringify({ findings: [{ line: 1 }] })), {
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
        });
        const result = await client.complete("sys", "usr", 512);
        const parsed = JSON.parse(result) as { findings: { line: number }[] };
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.findings[0]!.line).toBe(1);
      },
    );
  });

  test("throws on empty response content", async () => {
    await withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-empty",
            object: "chat.completion",
            created: 1700000000,
            model: "test-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
        });
        let thrownError: unknown = null;
        try {
          await client.complete("sys", "usr", 512);
        } catch (error) {
          thrownError = error;
        }
        expect(thrownError).toBeInstanceOf(Error);
        expect((thrownError as Error).message).toContain("LLM returned empty response");
      },
    );
  });
});

describe("reviewFile (via fake HTTP server)", () => {
  test("returns validated findings through the full pipeline", async () => {
    const diff = makeDiff("src/app.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+const data = fetch()",
        "+const info = parse(data)",
        "+export default info",
      ]),
    ]);

    await withMockFetch(
      () =>
        new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                {
                  line: 1,
                  category: "idiomatic",
                  confidence: 0.85,
                  evidence: "const data = fetch()",
                  recommendation: "Rename 'data' to describe what is being fetched.",
                },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
          maxRetries: 0,
        });
        const codebaseContext = makeMockCodebaseContext({
          "src/app.ts": "const data = fetch()\nconst info = parse(data)\nexport default info",
        });
        const findings = await reviewFile({ fileDiff: diff, pullRequest: PULL_REQUEST_METADATA, codebaseContext, client });
        expect(findings).toHaveLength(1);
        expect(findings[0]!.line).toBe(1);
        expect(findings[0]!.category).toBe("idiomatic");
        expect(findings[0]!.confidence).toBe(0.85);
        expect(findings[0]!.ruleId).toBe("llm/reviewer");
        expect(findings[0]!.filePath).toBe("src/app.ts");
        expect(findings[0]!.patchSuggestionPolicy).toBeUndefined();
        expect(findings[0]!.status).toBe("posted");
      },
    );
  });

  test("returns empty array when LLM finds nothing", async () => {
    const diff = makeDiff("src/clean.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+export const VERSION = '1.0.0'"]),
    ]);

    await withMockFetch(
      () =>
        new Response(buildCompletionResponse(JSON.stringify({ findings: [] })), {
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
          maxRetries: 0,
        });
        const findings = await reviewFile({ fileDiff: diff, pullRequest: PULL_REQUEST_METADATA, codebaseContext: makeMockCodebaseContext(), client });
        expect(findings).toHaveLength(0);
      },
    );
  });

  test("discards hallucinated line numbers from LLM", async () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+const valid = true"]),
    ]);

    await withMockFetch(
      () =>
        new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                {
                  line: 999,
                  category: "clean",
                  confidence: 0.9,
                  evidence: "ghost",
                  recommendation: "Does not exist.",
                },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
          maxRetries: 0,
        });
        const findings = await reviewFile({ fileDiff: diff, pullRequest: PULL_REQUEST_METADATA, codebaseContext: makeMockCodebaseContext(), client });
        expect(findings).toHaveLength(0);
      },
    );
  });

  test("handles file not found in codebase gracefully", async () => {
    const diff = makeDiff("src/new-file.ts", [
      makeHunk("@@ -0,0 +1,1 @@", ["+export const NEW = true"]),
    ]);

    await withMockFetch(
      () =>
        new Response(buildCompletionResponse(JSON.stringify({ findings: [] })), {
          headers: { "Content-Type": "application/json" },
        }),
      async () => {
        const client = createReviewClient({
          apiKey: "test-key",
          baseUrl: "http://mock.local/v1",
          model: "test-model",
          maxRetries: 0,
        });
        const emptyContext = makeMockCodebaseContext();
        const findings = await reviewFile({ fileDiff: diff, pullRequest: PULL_REQUEST_METADATA, codebaseContext: emptyContext, client });
        expect(findings).toHaveLength(0);
      },
    );
  });
});

describe("createLlmReviewerRule", () => {
  test("returns a codebase-aware rule with correct metadata", () => {
    const rule = createLlmReviewerRule({
      clientConfig: { apiKey: "test-key" },
    });

    expect(rule.kind).toBe("codebase-aware");
    expect(rule.metadata.ruleId).toBe("llm/reviewer");
    expect(rule.metadata.category).toBe("idiomatic");
    expect(rule.metadata.languages).toContain("typescript");
  });

  test("returns empty findings when no files match selection criteria", async () => {
    const rule = createLlmReviewerRule({
      clientConfig: { apiKey: "test-key" },
    });

    const context = {
      diffs: [
        makeDiff("README.md", [makeHunk("@@ -0,0 +1,1 @@", ["+# Hello"])]),
        makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+test()"])]),
      ],
      pullRequest: PULL_REQUEST_METADATA,
    };

    const codebaseContext = makeMockCodebaseContext();
    const findings = await rule.analyse(context, codebaseContext);
    expect(findings).toHaveLength(0);
  });

  test("analyses selected files and returns findings via fake server", async () => {
    await withMockFetch(
      () =>
        new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                {
                  line: 1,
                  category: "clean",
                  confidence: 0.88,
                  evidence: "const result = processData()",
                  recommendation: "Rename 'result' to describe the processed output.",
                },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },
        });
        const context = {
          diffs: [
            makeDiff("src/service.ts", [
              makeHunk("@@ -0,0 +1,2 @@", [
                "+const result = processData()",
                "+export default result",
              ]),
            ]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const codebaseContext = makeMockCodebaseContext({
          "src/service.ts": "const result = processData()\nexport default result",
        });
        const findings = await rule.analyse(context, codebaseContext);
        expect(findings).toHaveLength(1);
        expect(findings[0]!.ruleId).toBe("llm/reviewer");
        expect(findings[0]!.filePath).toBe("src/service.ts");
        expect(findings[0]!.line).toBe(1);
        expect(findings[0]!.category).toBe("clean");
        expect(findings[0]!.confidence).toBe(0.88);
      },
    );
  });

  test("reviews multiple files and flattens findings", async () => {
    await withMockFetch(
      async (request) => {
        const body = await request.json() as { messages?: { content?: string }[] };
        const userMessage = body.messages?.find((message) => message.content?.includes("## File:"))?.content ?? "";
        const isFileA = userMessage.includes("## File: src/a.ts");
        const findingsForFile = isFileA
          ? [{ line: 1, category: "idiomatic", confidence: 0.8, evidence: "a", recommendation: "fix a" }]
          : [{ line: 1, category: "safety", confidence: 0.9, evidence: "b", recommendation: "fix b" }];
        return new Response(buildCompletionResponse(JSON.stringify({ findings: findingsForFile })), {
          headers: { "Content-Type": "application/json" },
        });
      },
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
          },
        });
        const context = {
          diffs: [
            makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const aa = 1"])]),
            makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const bb = 2"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings).toHaveLength(2);
        const filePaths = findings.map((finding) => finding.filePath);
        expect(filePaths).toContain("src/a.ts");
        expect(filePaths).toContain("src/b.ts");
      },
    );
  });

  test("continues silently when a file review fails without onFileReviewError", async () => {
    await withMockFetch(
      () => new Response("Internal Server Error", { status: 500 }),
      async () => {
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
            maxRetries: 0,
          },
        });
        const context = {
          diffs: [
            makeDiff("src/fail.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings).toHaveLength(0);
      },
    );
  });

  test("calls onFileReviewError and continues when a file review fails", async () => {
    let invocationCount = 0;
    await withMockFetch(
      () => {
        invocationCount += 1;
        if (invocationCount === 1) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          buildCompletionResponse(
            JSON.stringify({
              findings: [
                { line: 1, category: "clean", confidence: 0.9, evidence: "ok", recommendation: "keep" },
              ],
            }),
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      },
      async () => {
        const errors: { filePath: string; error: unknown }[] = [];
        const rule = createLlmReviewerRule({
          clientConfig: {
            apiKey: "test-key",
            baseUrl: "http://mock.local/v1",
            model: "test-model",
            maxRetries: 0,
          },
          onFileReviewError: (filePath, error) => {
            errors.push({ filePath, error });
          },
        });
        const context = {
          diffs: [
            makeDiff("src/fail.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const x = 1"])]),
            makeDiff("src/pass.ts", [makeHunk("@@ -0,0 +1,1 @@", ["+const y = 2"])]),
          ],
          pullRequest: PULL_REQUEST_METADATA,
        };
        const findings = await rule.analyse(context, makeMockCodebaseContext());
        expect(findings).toHaveLength(1);
        expect(findings[0]!.filePath).toBe("src/pass.ts");
        expect(errors).toHaveLength(1);
        expect(errors[0]!.filePath).toBe("src/fail.ts");
      },
    );
  });
});
