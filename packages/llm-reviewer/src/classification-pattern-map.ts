import type { AntiPattern } from "./anti-pattern-types";

/**
 * Maps triage classification strings to the anti-pattern IDs they are relevant to.
 *
 * @remarks
 * Classifications are free-form strings produced by the triage LLM. This map covers
 * the strings suggested in the triage prompt plus common natural variants. When a
 * classification is not found, the filter function falls back to the full catalogue.
 */
const CLASSIFICATION_TO_PATTERN_IDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["god-function-growth", [
    "god-component",
    "mixed-concerns-component",
  ]],
  ["new-react-component", [
    "god-component",
    "mixed-concerns-component",
    "prop-drilling",
    "derived-state-as-use-state",
    "stale-closure-in-effect",
    "useeffect-as-event-handler",
    "expensive-computation-in-render",
    "new-object-in-context-value",
    "missing-use-callback-handler",
    "missing-react-memo",
    "class-based-component",
    "object-spread-for-optional-props",
  ]],
  ["interface-change", [
    "fat-interface",
    "lsp-violation-incomplete-override",
    "inconsistent-absent-value",
    "overly-wide-generic",
    "exposed-mutable-collection",
    "long-parameter-list",
  ]],
  ["error-handling", [
    "implicit-any-in-catch",
  ]],
  ["type-safety", [
    "overly-wide-generic",
    "inconsistent-absent-value",
    "implicit-any-in-catch",
  ]],
  ["state-management", [
    "derived-state-as-use-state",
    "stale-closure-in-effect",
    "useeffect-as-event-handler",
    "new-object-in-context-value",
  ]],
  ["api-boundary", [
    "hardcoded-dependency",
    "implicit-any-in-catch",
  ]],
  ["naming-issues", [
    "magic-literal",
    "boolean-flag-parameter",
  ]],
  ["mixed-responsibilities", [
    "god-component",
    "mixed-concerns-component",
    "query-with-side-effect",
    "scattered-event-handling",
  ]],
  ["component-complexity", [
    "god-component",
    "mixed-concerns-component",
    "expensive-computation-in-render",
  ]],
  ["coupling", [
    "hardcoded-dependency",
    "prop-drilling",
  ]],
  ["switch-chain", [
    "switch-on-type",
    "instanceof-type-dispatch",
  ]],
  ["strategy-pattern", [
    "switch-on-type",
    "instanceof-type-dispatch",
  ]],
  ["duplication", [
    "manual-object-construction",
    "imperative-loop-over-array",
    "mutable-accumulator",
    "scattered-event-handling",
  ]],
  ["side-effects", [
    "query-with-side-effect",
    "options-object-mutation",
  ]],
  ["prop-drilling", [
    "prop-drilling",
  ]],
  ["hook-misuse", [
    "derived-state-as-use-state",
    "stale-closure-in-effect",
    "useeffect-as-event-handler",
  ]],
  ["nested-conditionals", [
    "deeply-nested-callbacks",
  ]],
  ["complex-boolean", [
    "deeply-nested-callbacks",
  ]],
  ["hardcoded-dependency", [
    "hardcoded-dependency",
  ]],
  ["fat-interface", [
    "fat-interface",
  ]],
  ["lsp-violation", [
    "lsp-violation-incomplete-override",
  ]],
  ["query-side-effect", [
    "query-with-side-effect",
  ]],
  ["try-catch-misuse", [
    "implicit-any-in-catch",
  ]],
  ["type-assertion-misuse", [
    "overly-wide-generic",
  ]],
  ["long-parameter-list", [
    "long-parameter-list",
    "boolean-flag-parameter",
  ]],
]);

/**
 * Normalises a triage classification label to its canonical form.
 *
 * @remarks
 * Lowercases, trims whitespace, and replaces spaces/underscores with hyphens
 * so that variants like "Long Parameter List" and "long_parameter_list" resolve
 * to the canonical "long-parameter-list" key.
 */
function normaliseClassification(label: string): string {
  return label.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * Filters anti-patterns to those relevant to the given triage classifications.
 *
 * @param classifications - Triage classifications for a single file.
 * @param allPatterns - Full anti-pattern catalogue.
 * @returns Filtered subset of patterns, or the full catalogue when classifications
 *   are empty or none match any known mapping.
 */
export function filterPatternsByClassifications(
  classifications: readonly string[],
  allPatterns: readonly AntiPattern[],
): readonly AntiPattern[] {
  if (classifications.length === 0) return allPatterns;

  const matchedIds = new Set<string>();
  for (const classification of classifications) {
    const patternIds =
      CLASSIFICATION_TO_PATTERN_IDS.get(classification) ??
      CLASSIFICATION_TO_PATTERN_IDS.get(normaliseClassification(classification));
    if (patternIds) {
      for (const id of patternIds) {
        matchedIds.add(id);
      }
    }
  }

  if (matchedIds.size === 0) return allPatterns;

  const filtered = allPatterns.filter((pattern) => matchedIds.has(pattern.id));

  return filtered.length === 0 ? allPatterns : filtered;
}
