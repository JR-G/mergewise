import type { AntiPattern } from "./anti-pattern-types";

export const SAFETY_PATTERNS: readonly AntiPattern[] = [
  {
    id: "overly-wide-generic",
    title: "Overly wide generic constraint",
    description:
      "A generic type parameter constrained to a very wide type (object, Record<string, unknown>, any) that provides no meaningful type narrowing.",
    category: "safety",
    languages: ["typescript"],
    badExample: `function merge<T extends object>(a: T, b: T): T {
  return { ...a, ...b };
}`,
    goodExample: `function merge<T extends Record<string, unknown>>(
  a: T, b: Partial<T>
): T {
  return { ...a, ...b };
}`,
    principle: "Type safety — constrain generics to the narrowest useful bound",
    detectionHint:
      "Generic parameter with 'extends object', 'extends {}', 'extends any', or 'extends Record<string, any>' where a narrower constraint exists.",
  },

  {
    id: "implicit-any-in-catch",
    title: "Implicit any in catch clause",
    description:
      "Using the caught error as if it were a typed Error instance without narrowing, risking runtime TypeError if a non-Error is thrown.",
    category: "safety",
    languages: ["typescript"],
    badExample: `try { riskyOp(); }
catch (err) {
  console.error(err.message);
  throw new AppError(err.code);
}`,
    goodExample: `try { riskyOp(); }
catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new AppError(message);
}`,
    principle: "Defensive typing — unknown over any in catch",
    detectionHint:
      "Catch clause accessing .message, .code, .stack, or other properties on the error parameter without an instanceof or typeof guard.",
  },

];
