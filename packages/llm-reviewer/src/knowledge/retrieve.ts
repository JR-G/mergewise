import type { ReviewSignals, StructuralSignals } from "../signals";
import type { KnowledgeDocument, SignalTag } from "../pipeline-types";
import { deriveSignalTags } from "./signal-tags";
import { KNOWLEDGE_REGISTRY } from "./registry";

const MAX_DOCUMENTS_PER_FILE = 5;
const SIGNAL_TAG_SCORE = 2;
const CLASSIFICATION_SCORE = 3;
const EXTENSION_BONUS = 1;


/**
 * Input for knowledge retrieval: signals, file extension, and triage classifications.
 */
export interface RetrievalInput {
  readonly signals: StructuralSignals;
  readonly reviewSignals?: ReviewSignals | undefined;
  readonly fileExtension: string;
  readonly classifications: readonly string[];
}

interface ScoredDocument {
  readonly document: KnowledgeDocument;
  readonly score: number;
}

/**
 * Scores a single knowledge document against the retrieval input.
 *
 * @returns Relevance score; 0 means the document should not be included.
 */
function scoreDocument(
  document: KnowledgeDocument,
  tagSet: ReadonlySet<SignalTag>,
  classificationSet: ReadonlySet<string>,
  fileExtension: string,
): number {
  if (document.fileExtensions.length > 0 && !document.fileExtensions.includes(fileExtension)) {
    return 0;
  }

  let score = 0;

  for (const trigger of document.triggerSignals) {
    if (tagSet.has(trigger)) score += SIGNAL_TAG_SCORE;
  }

  for (const classification of document.triggerClassifications) {
    if (classificationSet.has(classification)) score += CLASSIFICATION_SCORE;
  }

  if (document.fileExtensions.length > 0 && document.fileExtensions.includes(fileExtension)) {
    score += EXTENSION_BONUS;
  }

  return score;
}

/**
 * Retrieves knowledge documents relevant to a file based on structural
 * signals, triage classifications, and file extension.
 *
 * @remarks
 * Uses structured matching — not embeddings. Classification matches score
 * highest (3 pts), signal tag matches score 2 pts, and extension match
 * adds 1 pt. Results are capped at {@link MAX_DOCUMENTS_PER_FILE}.
 *
 * @param input - Retrieval criteria.
 * @param registry - Knowledge documents to search. Defaults to the built-in registry.
 * @returns Relevant documents ordered by descending relevance score.
 */
export function retrieveKnowledge(
  input: RetrievalInput,
  registry: readonly KnowledgeDocument[] = KNOWLEDGE_REGISTRY,
): readonly KnowledgeDocument[] {
  const tags = deriveSignalTags(input.signals, input.reviewSignals);
  const tagSet = new Set(tags);
  const classificationSet = new Set(input.classifications);

  const scored: ScoredDocument[] = [];

  for (const document of registry) {
    const score = scoreDocument(document, tagSet, classificationSet, input.fileExtension);
    if (score > 0) {
      scored.push({ document, score });
    }
  }

  scored.sort((left, right) => right.score - left.score);

  return scored.slice(0, MAX_DOCUMENTS_PER_FILE).map((entry) => entry.document);
}
