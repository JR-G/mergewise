import type { KnowledgeDocument } from "../pipeline-types";
import { GOD_FUNCTION_KNOWLEDGE } from "./god-function";
import { REACT_HOOKS_KNOWLEDGE } from "./react-hooks";
import { ERROR_HANDLING_KNOWLEDGE } from "./error-handling";
import { TYPE_SAFETY_KNOWLEDGE } from "./type-safety";

/**
 * Frozen registry of all available knowledge documents.
 *
 * @remarks
 * Add new documents here — they become automatically available to
 * the retrieval function without any pipeline changes.
 */
export const KNOWLEDGE_REGISTRY: readonly KnowledgeDocument[] = Object.freeze([
  GOD_FUNCTION_KNOWLEDGE,
  REACT_HOOKS_KNOWLEDGE,
  ERROR_HANDLING_KNOWLEDGE,
  TYPE_SAFETY_KNOWLEDGE,
]);
