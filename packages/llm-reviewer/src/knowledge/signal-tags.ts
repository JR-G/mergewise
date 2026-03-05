import type { StructuralSignals } from "../signals";
import type { SignalTag } from "../pipeline-types";

const HOOK_PRESENCE_THRESHOLD = 0;
const HIGH_HOOK_THRESHOLD = 3;
const HIGH_FUNCTION_COUNT_THRESHOLD = 5;
const LARGE_FUNCTION_LINE_THRESHOLD = 40;
const HIGH_NESTING_THRESHOLD = 3;
const HIGH_PARAM_THRESHOLD = 3;
const TYPE_ASSERTION_THRESHOLD = 2;
const HIGH_IMPORT_THRESHOLD = 10;
const LARGE_COMPONENT_LINE_THRESHOLD = 50;

/**
 * Converts numeric structural signals into boolean signal tags
 * for knowledge document matching.
 *
 * @param signals - Structural signals extracted from a file diff.
 * @returns Signal tags indicating which knowledge domains are relevant.
 */
export function deriveSignalTags(signals: StructuralSignals): readonly SignalTag[] {
  const tags: SignalTag[] = [];

  if (signals.hookCount > HOOK_PRESENCE_THRESHOLD) tags.push("has_hooks");
  if (signals.hookCount >= HIGH_HOOK_THRESHOLD) tags.push("high_hook_count");
  if (signals.classCount > 0) tags.push("has_classes");
  if (signals.functionCount > HIGH_FUNCTION_COUNT_THRESHOLD) tags.push("high_function_count");
  if (signals.maxFunctionLineCount > LARGE_FUNCTION_LINE_THRESHOLD) tags.push("large_function");
  if (signals.maxNestingDepth > HIGH_NESTING_THRESHOLD) tags.push("high_nesting");
  if (signals.maxParameterCount > HIGH_PARAM_THRESHOLD) tags.push("high_param_count");
  if (signals.typeAssertionCount > TYPE_ASSERTION_THRESHOLD) tags.push("has_type_assertions");
  if (signals.importCount > HIGH_IMPORT_THRESHOLD) tags.push("high_import_count");
  if (signals.componentLineCount > LARGE_COMPONENT_LINE_THRESHOLD) tags.push("large_component");

  return tags;
}
