import type { KnowledgeDocument, KnowledgeExample } from "../pipeline-types";

const MAX_KNOWLEDGE_CHARS = 8000;

/**
 * Formats a single example into a markdown block.
 */
function formatExample(example: KnowledgeExample): string {
  return [
    `#### ${example.label}`,
    example.scenario,
    "",
    "Bad:",
    "```",
    example.bad,
    "```",
    "",
    "Good:",
    "```",
    example.good,
    "```",
    "",
    example.explanation,
  ].join("\n");
}

/**
 * Formats a single knowledge document into a markdown section.
 */
function formatDocument(document: KnowledgeDocument): string {
  const parts = [
    `### ${document.title}`,
    "",
    document.content,
  ];

  for (const example of document.examples) {
    parts.push("");
    parts.push(formatExample(example));
  }

  return parts.join("\n");
}

/**
 * Formats retrieved knowledge documents into a prompt section string.
 *
 * @remarks
 * Documents are formatted in order until the character cap is reached.
 * This prevents context bloat when many documents match.
 *
 * @param documents - Knowledge documents to format.
 * @returns Formatted markdown string, or empty string if no documents.
 */
export function formatKnowledgeSection(
  documents: readonly KnowledgeDocument[],
): string {
  if (documents.length === 0) return "";

  const header = "## Relevant patterns and principles\n";
  const parts: string[] = [header];
  let totalLength = header.length;

  for (const document of documents) {
    const section = formatDocument(document);

    if (totalLength + section.length > MAX_KNOWLEDGE_CHARS) break;

    parts.push(section);
    parts.push("");
    totalLength += section.length;
  }

  return parts.join("\n");
}
