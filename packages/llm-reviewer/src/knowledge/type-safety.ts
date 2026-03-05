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
  content: `Type assertions (as) and overly wide generics (any, object, Record<string, unknown>) disable the compiler's ability to catch errors at build time. Each assertion is a promise from the developer that they know better than the type checker — and these promises rot as code changes.

Key anti-patterns:

1. Type assertions to silence errors
Using "as Type" to force a value into a shape the compiler cannot verify. When the runtime value does not match the asserted type, the error surfaces far from the assertion site, often as a "cannot read property of undefined."

2. Overly wide generic constraints
Generics constrained to object or Record<string, unknown> provide no meaningful narrowing. The consumer gets back a type that requires further assertions to use, defeating the purpose of the generic.

3. Inconsistent absence representation
An interface that uses null for one optional field, undefined for another, and a boolean flag for a third. Callers must check three different patterns for the same semantic concept, and refactoring misses one.

4. Non-null assertions (!)
The postfix ! operator tells the compiler "I know this is not null" without a runtime check. If the assumption is wrong, the error manifests as a TypeError at the access site with no indication of why the value was null.

5. any in function boundaries
Parameters typed as any accept anything and return types inferred as any propagate unchecked values through the call chain. Prefer unknown with explicit narrowing.

When NOT to flag:
- Type assertions in test files for mock construction — tests intentionally create partial objects
- A single "as const" assertion — this narrows rather than widens
- Generic constraints like T extends string — this is meaningful narrowing
- Type assertions immediately preceded by a runtime type guard on the same value`,
  examples: [
    {
      label: "Type assertion masking a shape mismatch",
      scenario:
        "A function asserts an API response matches a type without validation.",
      bad: `async function getUser(id: string): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  const data = await response.json();
  return data as User;
}`,
      good: `async function getUser(id: string): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  const data: unknown = await response.json();
  if (!isUser(data)) {
    throw new Error(\`Invalid user response for \${id}\`);
  }
  return data;
}`,
      explanation:
        "The assertion version silently passes if the API returns a different shape. The validated version fails fast with a clear message, preventing corrupted data from propagating through the application.",
    },
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
  ],
};
