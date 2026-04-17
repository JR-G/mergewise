import { z } from "zod";
import type { FilePath, RepoFullName } from "@mergewise/shared-types";
import type { ReviewToolkit } from "./pipeline-types";
import { KNOWLEDGE_REGISTRY } from "./knowledge/registry";
import { formatKnowledgeSection } from "./knowledge/format";
import type OpenAI from "openai";

const MAX_READ_LINES = 500;
const MAX_READ_CHARS = 50_000;
const MAX_CALLERS_IN_RESULT = 10;
const MAX_LEARNINGS_IN_RESULT = 5;
const MAX_REUSABLE_SYMBOLS_IN_RESULT = 10;
const MAX_REUSABLE_EXAMPLES_IN_RESULT = 5;
const MAX_REUSABLE_EXAMPLE_SNIPPET_CHARS = 2_000;

/**
 * Context provided to tool execute functions.
 *
 * @remarks
 * Each tool closes over this context at execution time.
 * All data is already in memory — no async needed.
 */
export interface ToolContext {
  readonly filePath: FilePath;
  readonly fullContent: string | null;
  readonly toolkit: ReviewToolkit | undefined;
  readonly repoName: RepoFullName;
}

/**
 * A provider-agnostic tool definition with Zod-validated input.
 *
 * @remarks
 * No OpenAI types leak into tool definitions. The {@link toOpenAiTools}
 * function is the only place where provider-specific conversion happens.
 */
export interface ReviewTool<TSchema extends z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  readonly execute: (args: z.infer<TSchema>, context: ToolContext) => string;
}

const readFileSectionSchema = z.object({
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});

export const readFileSection: ReviewTool<typeof readFileSectionSchema> = {
  name: "read_file_section",
  description:
    "Read a section of the full file content (not just the diff). Use this when you need surrounding context to understand a change.",
  schema: readFileSectionSchema,
  execute: (args, context) => {
    if (context.fullContent === null) {
      return "Error: file content not available";
    }

    const { startLine, endLine } = args;
    if (startLine > endLine) {
      return `Error: startLine (${startLine}) must be <= endLine (${endLine})`;
    }

    const requestedLines = endLine - startLine + 1;
    if (requestedLines > MAX_READ_LINES) {
      return `Error: requested ${requestedLines} lines, maximum is ${MAX_READ_LINES}`;
    }

    const fileLines = context.fullContent.split("\n");
    const clampedEnd = Math.min(endLine, fileLines.length);
    if (startLine > fileLines.length) {
      return `Error: startLine (${startLine}) exceeds file length (${fileLines.length} lines)`;
    }

    const slice = fileLines.slice(startLine - 1, clampedEnd);
    let charCount = 0;
    const outputLines: string[] = [];
    for (let index = 0; index < slice.length; index++) {
      const formatted = `${startLine + index}: ${slice[index]}`;
      if (charCount + formatted.length + (index > 0 ? 1 : 0) > MAX_READ_CHARS) {
        outputLines.push("...[truncated]");
        break;
      }
      charCount += formatted.length + (index > 0 ? 1 : 0);
      outputLines.push(formatted);
    }
    return outputLines.join("\n");
  },
};

const emptySchema = z.object({});

export const getCallers: ReviewTool<typeof emptySchema> = {
  name: "get_callers",
  description:
    "Get the list of files that import/depend on this file, its centrality score, and whether it is a change hotspot.",
  schema: emptySchema,
  execute: (_args, context) => {
    const graphContext = context.toolkit?.getCallers?.(context.filePath);
    if (!graphContext) {
      return "No graph context available";
    }

    const callers = graphContext.callers.slice(0, MAX_CALLERS_IN_RESULT);
    return JSON.stringify({
      callers,
      centrality: graphContext.centrality,
      isHotspot: graphContext.isHotspot,
    });
  },
};

const findReusableSymbolsSchema = z.object({
  query: z.string().min(1).max(80),
  kind: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_REUSABLE_SYMBOLS_IN_RESULT).optional(),
});

export const findReusableSymbols: ReviewTool<typeof findReusableSymbolsSchema> = {
  name: "find_reusable_symbols",
  description:
    "Search the repository symbol index for existing helpers, hooks, services, types, or components that may already solve the current problem.",
  schema: findReusableSymbolsSchema,
  execute: (args, context) => {
    const matches = context.toolkit?.findReusableSymbols?.(
      context.filePath,
      args.query,
      args.limit,
    );
    if (!matches || matches.length === 0) {
      return "No reusable symbols found";
    }

    const filteredMatches = typeof args.kind === "string"
      ? matches.filter((match) => match.kind === args.kind)
      : matches;
    if (filteredMatches.length === 0) {
      return "No reusable symbols found";
    }

    return JSON.stringify({
      query: args.query,
      matches: filteredMatches
        .slice(0, MAX_REUSABLE_SYMBOLS_IN_RESULT)
        .map((match) => ({
          name: match.name,
          kind: match.kind,
          filePath: match.filePath,
          line: match.line,
          exported: match.exported,
          relation: match.relation,
          score: match.score,
        })),
    });
  },
};

const findReusableExamplesSchema = z.object({
  query: z.string().min(1).max(80),
  kind: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_REUSABLE_EXAMPLES_IN_RESULT).optional(),
});

export const findReusableExamples: ReviewTool<typeof findReusableExamplesSchema> = {
  name: "find_reusable_examples",
  description:
    "Retrieve bounded declaration snippets for existing repository abstractions so you can compare against local code before suggesting a refactor.",
  schema: findReusableExamplesSchema,
  execute: (args, context) => {
    const matches = context.toolkit?.findReusableExamples?.(
      context.filePath,
      args.query,
      args.limit,
    );
    if (!matches || matches.length === 0) {
      return "No reusable examples found";
    }

    const filteredMatches = typeof args.kind === "string"
      ? matches.filter((match) => match.kind === args.kind)
      : matches;
    if (filteredMatches.length === 0) {
      return "No reusable examples found";
    }

    return JSON.stringify({
      query: args.query,
      matches: filteredMatches
        .slice(0, MAX_REUSABLE_EXAMPLES_IN_RESULT)
        .map((match) => ({
          name: match.name,
          kind: match.kind,
          filePath: match.filePath,
          line: match.line,
          exported: match.exported,
          relation: match.relation,
          score: match.score,
          snippet: truncateReusableExampleSnippet(match.snippet),
        })),
    });
  },
};

const lookupPatternSchema = z.object({
  patternId: z.string(),
});

export const lookupPattern: ReviewTool<typeof lookupPatternSchema> = {
  name: "lookup_pattern",
  description:
    "Retrieve a knowledge document for a specific anti-pattern by ID.",
  schema: lookupPatternSchema,
  execute: (args) => {
    const document = KNOWLEDGE_REGISTRY.find(
      (doc) => doc.id === args.patternId,
    );
    if (!document) {
      const validIds = KNOWLEDGE_REGISTRY.map((doc) => doc.id).join(", ");
      return `Unknown pattern ID: "${args.patternId}". Valid IDs: ${validIds}`;
    }

    return formatKnowledgeSection([document]);
  },
};

export const getRepoPreferences: ReviewTool<typeof emptySchema> = {
  name: "get_repo_preferences",
  description:
    "Get learned review preferences for this repository (from prior feedback/reactions).",
  schema: emptySchema,
  execute: (_args, context) => {
    const learnings = context.toolkit?.getRepoLearnings?.(
      context.repoName,
      [context.filePath],
    );

    if (!learnings || learnings.preferences.length === 0) {
      return "No preferences available";
    }

    return learnings.preferences
      .slice(0, MAX_LEARNINGS_IN_RESULT)
      .map((preference) => `- ${preference}`)
      .join("\n");
  },
};

export const REVIEW_TOOLS: readonly ReviewTool<z.ZodObject>[] = [
  readFileSection,
  getCallers,
  findReusableSymbols,
  findReusableExamples,
  lookupPattern,
  getRepoPreferences,
];

function truncateReusableExampleSnippet(snippet: string): string {
  if (snippet.length <= MAX_REUSABLE_EXAMPLE_SNIPPET_CHARS) {
    return snippet;
  }

  return `${snippet.slice(0, MAX_REUSABLE_EXAMPLE_SNIPPET_CHARS)}\n... [truncated]`;
}

/**
 * Converts provider-agnostic tool definitions to OpenAI's ChatCompletionTool format.
 *
 * @remarks
 * This is the only function that imports OpenAI types. When adding a new
 * provider, add a parallel conversion function (e.g. `toAnthropicTools`).
 */
export function toOpenAiTools(
  tools: readonly ReviewTool<z.ZodObject>[],
): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return tools.map((reviewTool) => ({
    type: "function" as const,
    function: {
      name: reviewTool.name,
      description: reviewTool.description,
      parameters: z.toJSONSchema(reviewTool.schema) as Record<string, unknown>,
    },
  }));
}

/**
 * Dispatches a tool call by name, validating args with Zod before execution.
 *
 * @param tools - Available tool definitions.
 * @param context - Execution context for the current file.
 * @param toolName - Name of the tool to execute.
 * @param rawArgs - JSON string of tool arguments from the model.
 * @returns Tool result string, or an error description.
 */
export function executeToolCall(
  tools: readonly ReviewTool<z.ZodObject>[],
  context: ToolContext,
  toolName: string,
  rawArgs: string,
): string {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return `Unknown tool: "${toolName}"`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs) as unknown;
  } catch {
    return `Invalid JSON arguments: ${rawArgs.slice(0, 200)}`;
  }

  const result = tool.schema.safeParse(parsed);
  if (!result.success) {
    return `Invalid arguments: ${result.error.message.slice(0, 500)}`;
  }

  try {
    return tool.execute(result.data, context);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Tool "${toolName}" failed: ${errorMessage.slice(0, 500)}`;
  }
}

/**
 * Builds a compact summary of available pattern IDs for inclusion in the user prompt.
 */
export function buildAvailablePatternsSummary(): string {
  const lines = KNOWLEDGE_REGISTRY.map(
    (doc) => `- ${doc.id}: ${doc.title}`,
  );
  return ["Available patterns for lookup_pattern tool:", ...lines].join("\n");
}
