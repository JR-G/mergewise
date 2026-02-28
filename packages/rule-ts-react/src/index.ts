import type { StatelessRule } from "@mergewise/shared-types";
import { unsafeAnyUsageRule } from "./unsafe-any";
import { nonNullAssertionRule } from "./non-null-assertion";
import { arrayIndexKeyRule } from "./array-index-key";
import { debuggerStatementRule } from "./debugger-statement";
import { typeAssertionChainRule } from "./type-assertion-chain";
import { enumDeclarationRule } from "./enum-declaration";
import { nestedTernaryRule } from "./nested-ternary";
import { negatedConditionRule } from "./negated-condition";
import { excessiveOptionalChainingRule } from "./excessive-optional-chaining";

export { unsafeAnyUsageRule } from "./unsafe-any";
export { nonNullAssertionRule } from "./non-null-assertion";
export { arrayIndexKeyRule } from "./array-index-key";
export { debuggerStatementRule } from "./debugger-statement";
export { typeAssertionChainRule } from "./type-assertion-chain";
export { enumDeclarationRule } from "./enum-declaration";
export { nestedTernaryRule } from "./nested-ternary";
export { negatedConditionRule } from "./negated-condition";
export { excessiveOptionalChainingRule } from "./excessive-optional-chaining";

/**
 * Deterministic list of stateless TypeScript and React rules for worker consumption.
 */
export const tsReactRules: readonly StatelessRule[] = [
  unsafeAnyUsageRule,
  nonNullAssertionRule,
  arrayIndexKeyRule,
  debuggerStatementRule,
  typeAssertionChainRule,
  enumDeclarationRule,
  nestedTernaryRule,
  negatedConditionRule,
  excessiveOptionalChainingRule,
];
