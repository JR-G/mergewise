import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for TypeScript type safety patterns.
 *
 * @remarks
 * Draws from the mkosir TypeScript style guide on discriminated unions,
 * Readonly, and avoiding any/assertions, and andredesousa best practices
 * on strict configuration and utility types.
 */
export const TYPE_SAFETY_KNOWLEDGE: KnowledgeDocument = {
  id: "type-safety",
  title: "TypeScript Type Safety Patterns",
  category: "safety",
  triggerSignals: ["has_type_assertions", "has_classes"],
  triggerClassifications: [
    "type-safety",
    "interface-change",
    "type-assertion-misuse",
  ],
  fileExtensions: [],
  content: `Type design determines how much code must change when a data shape evolves. The structural concern is not "could this assertion crash?" but "does this type design create coupling, inconsistency, or unnecessary branching across the codebase?"

Key structural anti-patterns:

1. Inconsistent absence representation
An interface that uses null for one optional field, undefined for another, and a boolean flag for a third. Every consumer must handle three different absent-value patterns for the same semantic concept, tripling the branching logic and making refactoring error-prone. Pick one convention and apply it consistently.

2. Stringly-typed discriminators
Using raw string comparisons instead of discriminated unions. Callers must know the valid string values by convention rather than by type. Adding a new variant requires finding every comparison site by text search. Discriminated unions make the compiler enforce exhaustiveness.

3. Overly wide generic constraints
Generics constrained to object or Record<string, unknown> provide no meaningful narrowing. The consumer gets back a type that requires further assertions to use, defeating the purpose of the generic. Narrow the constraint to the actual shape needed.

4. Type assertions masking missing abstractions
Repeated "as Type" casts in the same file often indicate a missing discriminated union or type guard. Instead of fixing the types, the code forces the compiler to accept the current shape. The fix is to model the actual variants in the type system.

When NOT to flag:
- Type assertions in test files for mock construction — tests intentionally create partial objects
- A single "as const" assertion — this narrows rather than widens
- Generic constraints like T extends string — this is meaningful narrowing
- Type assertions inside type guard functions or immediately preceded by a runtime check
- Do NOT suggest adding null checks, optional chaining, or defensive validation for internal type-safe code`,
  examples: [
    {
      label: "Inconsistent absence representation",
      scenario:
        "An interface uses three different patterns for optional values.",
      bad: `interface UserProfile {
  name: string;
  email: string | null;
  phone?: string;
  hasAvatar: boolean;
  avatarUrl: string | undefined;
}`,
      good: `interface UserProfile {
  name: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
}`,
      explanation:
        "A single absence pattern (| null) means callers check one way. Mixed patterns mean every consumer must know which check to use for which field, and refactoring from optional to nullable misses call sites.",
    },
    {
      label: "Stringly-typed discriminator instead of discriminated union",
      scenario:
        "A function uses string comparison to dispatch behaviour instead of a discriminated union.",
      bad: `function handleEvent(event: { type: string; payload: unknown }) {
  if (event.type === "user_created") {
    const user = event.payload as UserPayload;
    notifyUser(user);
  } else if (event.type === "order_placed") {
    const order = event.payload as OrderPayload;
    processOrder(order);
  }
}`,
      good: `type AppEvent =
  | { type: "user_created"; payload: UserPayload }
  | { type: "order_placed"; payload: OrderPayload };

function handleEvent(event: AppEvent) {
  switch (event.type) {
    case "user_created": return notifyUser(event.payload);
    case "order_placed": return processOrder(event.payload);
  }
}`,
      explanation:
        "The discriminated union eliminates all type assertions and makes the compiler enforce exhaustiveness — adding a new event type causes a compile error at every switch that does not handle it.",
    },
  ],
};
