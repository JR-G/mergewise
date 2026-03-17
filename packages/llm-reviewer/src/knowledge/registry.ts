import type { KnowledgeDocument } from "../pipeline-types";
import { COPY_PASTE_DUPLICATION_KNOWLEDGE } from "./copy-paste-duplication";
import { DEPENDENCY_INVERSION_KNOWLEDGE } from "./dependency-inversion";
import { ERROR_HANDLING_KNOWLEDGE } from "./error-handling";
import { GOD_FUNCTION_KNOWLEDGE } from "./god-function";
import { INTERFACE_SEGREGATION_KNOWLEDGE } from "./interface-segregation";
import { LONG_PARAMETER_LIST_KNOWLEDGE } from "./long-parameter-list";
import { NESTED_CONDITIONALS_KNOWLEDGE } from "./nested-conditionals";
import { PROP_DRILLING_KNOWLEDGE } from "./prop-drilling";
import { REACT_HOOKS_KNOWLEDGE } from "./react-hooks";
import { SIDE_EFFECTS_PURITY_KNOWLEDGE } from "./side-effects-purity";
import { STRATEGY_DISPATCH_KNOWLEDGE } from "./strategy-dispatch";
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
  NESTED_CONDITIONALS_KNOWLEDGE,
  PROP_DRILLING_KNOWLEDGE,
  DEPENDENCY_INVERSION_KNOWLEDGE,
  LONG_PARAMETER_LIST_KNOWLEDGE,
  COPY_PASTE_DUPLICATION_KNOWLEDGE,
  STRATEGY_DISPATCH_KNOWLEDGE,
  SIDE_EFFECTS_PURITY_KNOWLEDGE,
  INTERFACE_SEGREGATION_KNOWLEDGE,
]);
