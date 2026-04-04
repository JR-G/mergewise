import { describe, expect, test } from "bun:test";
import { deriveSignalTags } from "./signal-tags";
import { makeReviewSignals, makeSignals } from "./test-helpers";

describe("deriveSignalTags", () => {
  test("returns empty array for zero signals", () => {
    const tags = deriveSignalTags(makeSignals());
    expect(tags).toEqual([]);
  });

  test("returns has_hooks when hookCount is 1", () => {
    const tags = deriveSignalTags(makeSignals({ hookCount: 1 }));
    expect(tags).toContain("has_hooks");
    expect(tags).not.toContain("high_hook_count");
  });

  test("returns both hook tags when hookCount is 3", () => {
    const tags = deriveSignalTags(makeSignals({ hookCount: 3 }));
    expect(tags).toContain("has_hooks");
    expect(tags).toContain("high_hook_count");
  });

  test("returns has_classes when classCount is 1", () => {
    const tags = deriveSignalTags(makeSignals({ classCount: 1 }));
    expect(tags).toContain("has_classes");
  });

  test("returns high_function_count when functionCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ functionCount: 5 }))).not.toContain("high_function_count");
    expect(deriveSignalTags(makeSignals({ functionCount: 6 }))).toContain("high_function_count");
  });

  test("returns large_function when maxFunctionLineCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ maxFunctionLineCount: 40 }))).not.toContain("large_function");
    expect(deriveSignalTags(makeSignals({ maxFunctionLineCount: 41 }))).toContain("large_function");
  });

  test("returns high_nesting when maxNestingDepth exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ maxNestingDepth: 3 }))).not.toContain("high_nesting");
    expect(deriveSignalTags(makeSignals({ maxNestingDepth: 4 }))).toContain("high_nesting");
  });

  test("returns high_param_count when maxParameterCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ maxParameterCount: 3 }))).not.toContain("high_param_count");
    expect(deriveSignalTags(makeSignals({ maxParameterCount: 4 }))).toContain("high_param_count");
  });

  test("returns has_type_assertions when typeAssertionCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ typeAssertionCount: 0 }))).not.toContain("has_type_assertions");
    expect(deriveSignalTags(makeSignals({ typeAssertionCount: 1 }))).toContain("has_type_assertions");
  });

  test("returns high_import_count when importCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ importCount: 10 }))).not.toContain("high_import_count");
    expect(deriveSignalTags(makeSignals({ importCount: 11 }))).toContain("high_import_count");
  });

  test("returns large_component when componentLineCount exceeds threshold", () => {
    expect(deriveSignalTags(makeSignals({ componentLineCount: 50 }))).not.toContain("large_component");
    expect(deriveSignalTags(makeSignals({ componentLineCount: 51 }))).toContain("large_component");
  });

  test("returns multiple tags when multiple thresholds are exceeded", () => {
    const tags = deriveSignalTags(makeSignals({
      hookCount: 5,
      functionCount: 10,
      maxNestingDepth: 5,
      classCount: 2,
    }));
    expect(tags).toContain("has_hooks");
    expect(tags).toContain("high_hook_count");
    expect(tags).toContain("high_function_count");
    expect(tags).toContain("high_nesting");
    expect(tags).toContain("has_classes");
  });

  test("returns empty array for negative signal values", () => {
    const tags = deriveSignalTags(makeSignals({ hookCount: -1, functionCount: -5 }));
    expect(tags).toEqual([]);
  });

  test("returns high_function_count for very large functionCount", () => {
    const tags = deriveSignalTags(makeSignals({ functionCount: Number.MAX_SAFE_INTEGER }));
    expect(tags).toContain("high_function_count");
  });

  test("returns empty array when functionCount is NaN", () => {
    const tags = deriveSignalTags(makeSignals({ functionCount: NaN }));
    expect(tags).toEqual([]);
  });

  test("does not return high_function_count for non-integer float below threshold", () => {
    const tags = deriveSignalTags(makeSignals({ functionCount: 3.7 }));
    expect(tags).not.toContain("high_function_count");
  });

  test("returns has_type_assertions when typeAssertionCount is 1", () => {
    const tags = deriveSignalTags(makeSignals({ typeAssertionCount: 1 }));
    expect(tags).toContain("has_type_assertions");
  });

  test("does not return has_type_assertions when typeAssertionCount is 0", () => {
    const tags = deriveSignalTags(makeSignals({ typeAssertionCount: 0 }));
    expect(tags).not.toContain("has_type_assertions");
  });

  test("returns review-oriented tags when explicit review signals are present", () => {
    const tags = deriveSignalTags(
      makeSignals(),
      makeReviewSignals({
        hasInlineProviderValue: true,
        hasRepeatedForwardedProp: true,
        hasStaticConfigTable: true,
        hasParameterMutation: true,
      }),
    );
    expect(tags).toContain("unstable_provider_value");
    expect(tags).toContain("repeated_prop_forwarding");
    expect(tags).toContain("static_config_table");
    expect(tags).toContain("parameter_mutation");
  });

  test("does not return review-oriented tags when explicit review signals are default", () => {
    const tags = deriveSignalTags(makeSignals(), makeReviewSignals());
    expect(tags).not.toContain("unstable_provider_value");
    expect(tags).not.toContain("repeated_prop_forwarding");
    expect(tags).not.toContain("static_config_table");
    expect(tags).not.toContain("parameter_mutation");
  });
});
