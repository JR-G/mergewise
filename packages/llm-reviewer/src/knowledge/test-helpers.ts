import type { ReviewSignals, StructuralSignals } from "../signals";

/**
 * Creates a {@link StructuralSignals} instance with zero defaults,
 * overridable per-field.
 */
export function makeSignals(overrides: Partial<StructuralSignals> = {}): StructuralSignals {
  return {
    componentLineCount: 0,
    hookCount: 0,
    importCount: 0,
    maxNestingDepth: 0,
    functionCount: 0,
    maxFunctionLineCount: 0,
    maxParameterCount: 0,
    classCount: 0,
    typeAssertionCount: 0,
    ...overrides,
  };
}

/**
 * Creates a {@link ReviewSignals} instance with false defaults,
 * overridable per-field.
 */
export function makeReviewSignals(overrides: Partial<ReviewSignals> = {}): ReviewSignals {
  return {
    hasInlineProviderValue: false,
    hasValidationMixedWithStateUpdates: false,
    hasRepeatedForwardedProp: false,
    forwardedPropName: null,
    hasStaticConfigTable: false,
    hasParameterMutation: false,
    hasMemoizedDisplayDerivation: false,
    ...overrides,
  };
}
