import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { toFilePath, toRepoFullName } from "@mergewise/shared-types";
import type { ToolContext, ReviewTool } from "./review-tools";
import {
  readFileSection,
  getCallers,
  findReusableSymbols,
  lookupPattern,
  getRepoPreferences,
  REVIEW_TOOLS,
  toOpenAiTools,
  executeToolCall,
  buildAvailablePatternsSummary,
} from "./review-tools";
import { KNOWLEDGE_REGISTRY } from "./knowledge/registry";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    filePath: toFilePath("src/index.ts"),
    fullContent: "line one\nline two\nline three\nline four\nline five",
    toolkit: undefined,
    repoName: toRepoFullName("owner/repo"),
    ...overrides,
  };
}

describe("readFileSection", () => {
  test("returns numbered lines for a valid range", () => {
    const result = readFileSection.execute({ startLine: 2, endLine: 4 }, makeContext());

    expect(result).toContain("2: line two");
    expect(result).toContain("3: line three");
    expect(result).toContain("4: line four");
    expect(result).not.toContain("1: line one");
    expect(result).not.toContain("5: line five");
  });

  test("returns single line when startLine equals endLine", () => {
    const result = readFileSection.execute({ startLine: 3, endLine: 3 }, makeContext());

    expect(result).toBe("3: line three");
  });

  test("returns error when fullContent is null", () => {
    const result = readFileSection.execute(
      { startLine: 1, endLine: 3 },
      makeContext({ fullContent: null }),
    );

    expect(result).toContain("Error");
    expect(result).toContain("not available");
  });

  test("returns error when startLine exceeds endLine", () => {
    const result = readFileSection.execute({ startLine: 5, endLine: 2 }, makeContext());

    expect(result).toContain("Error");
    expect(result).toContain("startLine");
  });

  test("returns error when range exceeds 500 lines", () => {
    const result = readFileSection.execute({ startLine: 1, endLine: 501 }, makeContext());

    expect(result).toContain("Error");
    expect(result).toContain("maximum");
  });

  test("returns error when startLine exceeds file length", () => {
    const result = readFileSection.execute({ startLine: 100, endLine: 105 }, makeContext());

    expect(result).toContain("Error");
    expect(result).toContain("exceeds file length");
  });

  test("clamps endLine to file length when range extends beyond EOF", () => {
    const result = readFileSection.execute({ startLine: 4, endLine: 10 }, makeContext());

    expect(result).toContain("4: line four");
    expect(result).toContain("5: line five");
    expect(result.split("\n")).toHaveLength(2);
  });

  test("handles file with single line", () => {
    const context = makeContext({ fullContent: "only line" });
    const result = readFileSection.execute({ startLine: 1, endLine: 1 }, context);

    expect(result).toBe("1: only line");
  });

  test("returns exceeds-file-length error for very large startLine", () => {
    const result = readFileSection.execute(
      { startLine: 1_000_000_000, endLine: 1_000_000_005 },
      makeContext(),
    );

    expect(result).toContain("Error");
    expect(result).toContain("exceeds file length");
  });

  test("truncates output when lines exceed MAX_READ_CHARS", () => {
    const longLine = "x".repeat(10_000);
    const lines = Array.from({ length: 20 }, () => longLine);
    const context = makeContext({ fullContent: lines.join("\n") });

    const result = readFileSection.execute({ startLine: 1, endLine: 20 }, context);

    expect(result.length).toBeLessThanOrEqual(60_000);
    expect(result).toContain("...[truncated]");
  });
});

describe("getCallers", () => {
  test("returns formatted graph context when toolkit provides callers", () => {
    const context = makeContext({
      toolkit: {
        getCallers: (filePath) => ({
          filePath,
          callers: [toFilePath("a.ts"), toFilePath("b.ts")],
          centrality: 0.75,
          isHotspot: true,
        }),
      },
    });

    const result = getCallers.execute({}, context);
    const parsed = JSON.parse(result) as Record<string, unknown>;

    expect(parsed["centrality"]).toBe(0.75);
    expect(parsed["isHotspot"]).toBe(true);
    expect(parsed["callers"]).toEqual(["a.ts", "b.ts"]);
  });

  test("caps callers at 10 entries", () => {
    const manyCallers = Array.from({ length: 20 }, (_, index) =>
      toFilePath(`file${index}.ts`),
    );
    const context = makeContext({
      toolkit: {
        getCallers: (filePath) => ({
          filePath,
          callers: manyCallers,
          centrality: 0.5,
          isHotspot: false,
        }),
      },
    });

    const result = getCallers.execute({}, context);
    const parsed = JSON.parse(result) as { callers: string[] };

    expect(parsed.callers).toHaveLength(10);
  });

  test("returns fallback when toolkit is undefined", () => {
    const result = getCallers.execute({}, makeContext());

    expect(result).toContain("No graph context available");
  });

  test("returns fallback when getCallers is undefined", () => {
    const context = makeContext({ toolkit: {} });
    const result = getCallers.execute({}, context);

    expect(result).toContain("No graph context available");
  });
});

describe("findReusableSymbols", () => {
  test("returns formatted reusable symbols when toolkit provides matches", () => {
    const context = makeContext({
      toolkit: {
        findReusableSymbols: () => ([
          {
            name: "useUserFilters",
            kind: "function",
            filePath: toFilePath("src/shared/hooks.ts"),
            line: 12,
            exported: true,
            relation: "imports",
            score: 42,
          },
        ]),
      },
    });

    const result = findReusableSymbols.execute({ query: "user filters" }, context);
    const parsed = JSON.parse(result) as {
      query: string;
      matches: Record<string, unknown>[];
    };

    expect(parsed.query).toBe("user filters");
    expect(parsed.matches[0]?.["name"]).toBe("useUserFilters");
    expect(parsed.matches[0]?.["relation"]).toBe("imports");
  });

  test("applies kind filtering after toolkit lookup", () => {
    const context = makeContext({
      toolkit: {
        findReusableSymbols: () => ([
          {
            name: "UserService",
            kind: "class",
            filePath: toFilePath("src/shared/UserService.ts"),
            line: 5,
            exported: true,
            relation: "repo",
            score: 20,
          },
          {
            name: "useUserService",
            kind: "function",
            filePath: toFilePath("src/shared/hooks.ts"),
            line: 12,
            exported: true,
            relation: "imports",
            score: 40,
          },
        ]),
      },
    });

    const result = findReusableSymbols.execute({ query: "user service", kind: "function" }, context);
    const parsed = JSON.parse(result) as { matches: Record<string, unknown>[] };

    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]?.["name"]).toBe("useUserService");
  });

  test("returns fallback when toolkit is undefined", () => {
    const result = findReusableSymbols.execute({ query: "user filters" }, makeContext());

    expect(result).toContain("No reusable symbols found");
  });
});

describe("lookupPattern", () => {
  test("returns formatted knowledge for a valid pattern ID", () => {
    const result = lookupPattern.execute({ patternId: "god-function" }, makeContext());

    expect(result).toContain("god function");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns error with valid IDs for unknown pattern ID", () => {
    const result = lookupPattern.execute({ patternId: "nonexistent" }, makeContext());

    expect(result).toContain("Unknown pattern ID");
    expect(result).toContain("nonexistent");
    expect(result).toContain("god-function");
  });

  test("returns content for each registry entry", () => {
    for (const document of KNOWLEDGE_REGISTRY) {
      const result = lookupPattern.execute({ patternId: document.id }, makeContext());
      expect(result.length).toBeGreaterThan(0);
      expect(result).not.toContain("Unknown pattern ID");
    }
  });
});

describe("getRepoPreferences", () => {
  test("returns formatted preferences when available", () => {
    const context = makeContext({
      toolkit: {
        getRepoLearnings: () => ({
          preferences: ["prefer functional style", "avoid classes"],
        }),
      },
    });

    const result = getRepoPreferences.execute({}, context);

    expect(result).toContain("prefer functional style");
    expect(result).toContain("avoid classes");
  });

  test("caps preferences at 5 entries", () => {
    const manyPreferences = Array.from({ length: 10 }, (_, index) =>
      `preference ${index}`,
    );
    const context = makeContext({
      toolkit: {
        getRepoLearnings: () => ({ preferences: manyPreferences }),
      },
    });

    const result = getRepoPreferences.execute({}, context);
    const lines = result.split("\n").filter((line) => line.startsWith("- "));

    expect(lines).toHaveLength(5);
  });

  test("returns fallback when toolkit is undefined", () => {
    const result = getRepoPreferences.execute({}, makeContext());

    expect(result).toContain("No preferences available");
  });

  test("returns fallback when preferences are empty", () => {
    const context = makeContext({
      toolkit: {
        getRepoLearnings: () => ({ preferences: [] }),
      },
    });

    const result = getRepoPreferences.execute({}, context);

    expect(result).toContain("No preferences available");
  });
});

describe("executeToolCall", () => {
  test("dispatches to the correct tool by name", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      JSON.stringify({ startLine: 1, endLine: 2 }),
    );

    expect(result).toContain("1: line one");
    expect(result).toContain("2: line two");
  });

  test("returns error for unknown tool name", () => {
    const result = executeToolCall(REVIEW_TOOLS, makeContext(), "nonexistent", "{}");

    expect(result).toContain("Unknown tool");
    expect(result).toContain("nonexistent");
  });

  test("returns error for invalid JSON arguments", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      "not valid json",
    );

    expect(result).toContain("Invalid JSON");
  });

  test("returns Zod validation error for wrong argument types", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      JSON.stringify({ startLine: "not a number", endLine: 5 }),
    );

    expect(result).toContain("Invalid arguments");
  });

  test("returns Zod validation error for negative line numbers", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      JSON.stringify({ startLine: -1, endLine: 5 }),
    );

    expect(result).toContain("Invalid arguments");
  });

  test("returns Zod validation error for non-integer line numbers", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      JSON.stringify({ startLine: 1.5, endLine: 5 }),
    );

    expect(result).toContain("Invalid arguments");
  });

  test("returns Zod validation error when startLine is 0", () => {
    const result = executeToolCall(
      REVIEW_TOOLS,
      makeContext(),
      "read_file_section",
      JSON.stringify({ startLine: 0, endLine: 5 }),
    );

    expect(result).toContain("Invalid arguments");
  });

  test("returns bounded error string when tool.execute throws", () => {
    const throwingTool: ReviewTool<z.ZodObject> = {
      name: "exploding_tool",
      description: "A tool that always throws",
      schema: z.object({}),
      execute: () => {
        throw new Error("Something went terribly wrong");
      },
    };

    const result = executeToolCall([throwingTool], makeContext(), "exploding_tool", "{}");

    expect(result).toContain('Tool "exploding_tool" failed');
    expect(result).toContain("Something went terribly wrong");
    expect(result.length).toBeLessThan(600);
  });

  test("truncates long error messages from tool.execute failures", () => {
    const longMessage = "e".repeat(1000);
    const throwingTool: ReviewTool<z.ZodObject> = {
      name: "long_error_tool",
      description: "A tool that throws a long error",
      schema: z.object({}),
      execute: () => {
        throw new Error(longMessage);
      },
    };

    const result = executeToolCall([throwingTool], makeContext(), "long_error_tool", "{}");

    expect(result).toContain('Tool "long_error_tool" failed');
    expect(result.length).toBeLessThan(600);
  });
});

describe("toOpenAiTools", () => {
  test("converts all review tools to OpenAI format", () => {
    const openAiTools = toOpenAiTools(REVIEW_TOOLS);

    expect(openAiTools).toHaveLength(REVIEW_TOOLS.length);
    for (const tool of openAiTools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeDefined();
    }
  });

  test("produces valid JSON Schema for readFileSection parameters", () => {
    const openAiTools = toOpenAiTools([readFileSection]);
    const params = openAiTools[0]!.function.parameters as Record<string, unknown>;

    expect(params["type"]).toBe("object");
    const properties = params["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["startLine"]).toBeDefined();
    expect(properties["endLine"]).toBeDefined();
  });

  test("produces valid JSON Schema for tools with no parameters", () => {
    const openAiTools = toOpenAiTools([getCallers]);
    const params = openAiTools[0]!.function.parameters as Record<string, unknown>;

    expect(params["type"]).toBe("object");
  });

  test("produces valid JSON Schema for reusable symbol lookup parameters", () => {
    const openAiTools = toOpenAiTools([findReusableSymbols]);
    const params = openAiTools[0]!.function.parameters as Record<string, unknown>;
    const properties = params["properties"] as Record<string, Record<string, unknown>>;

    expect(properties["query"]).toBeDefined();
    expect(properties["kind"]).toBeDefined();
    expect(properties["limit"]).toBeDefined();
  });
});

describe("buildAvailablePatternsSummary", () => {
  test("includes all knowledge registry entries", () => {
    const summary = buildAvailablePatternsSummary();

    for (const document of KNOWLEDGE_REGISTRY) {
      expect(summary).toContain(document.id);
      expect(summary).toContain(document.title);
    }
  });

  test("output length is bounded", () => {
    const summary = buildAvailablePatternsSummary();

    expect(summary.length).toBeLessThan(2000);
  });
});
