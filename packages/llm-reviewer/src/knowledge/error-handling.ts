import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for error handling patterns and anti-patterns.
 *
 * @remarks
 * Draws from TypeScript best practices (andredesousa) on using Error objects
 * with try-catch, the mkosir style guide on unknown vs any, and general
 * guidance on error boundary design.
 */
export const ERROR_HANDLING_KNOWLEDGE: KnowledgeDocument = {
  id: "error-handling",
  title: "Error Handling Patterns",
  category: "safety",
  triggerSignals: ["high_nesting"],
  triggerClassifications: [
    "error-handling",
    "api-boundary",
    "try-catch-misuse",
  ],
  fileExtensions: [],
  content: `Error handling at system boundaries determines whether failures are recoverable or cascade into silent data corruption. The cost of bad error handling is not the error itself — it is the hours spent debugging because the original failure was swallowed, mistyped, or lost.

Key anti-patterns:

1. Bare catch with untyped error
Accessing properties on a caught value without narrowing its type. In TypeScript, caught values are unknown. Accessing .message or .code without an instanceof guard throws at runtime if the caught value is not an Error.

2. Swallowed errors
Empty catch blocks or catch blocks that only log and continue. The caller has no way to know the operation failed and proceeds with stale or missing data.

3. Overly broad try blocks
Wrapping 30 lines in a single try-catch when only one line can throw. This catches unrelated errors and makes it impossible to handle each failure mode appropriately.

4. String-based error discrimination
Checking error.message with string matching (includes, startsWith) instead of using error subclasses or error codes. Message text changes between library versions, breaking the handler silently.

5. Re-throwing without cause
Catching an error, creating a new Error with a generic message, and throwing it without setting the cause property. The original stack trace and error details are lost.

When NOT to flag:
- catch blocks at the top-level request handler that log and return a 500 — this is the last-resort handler
- Defensive try-catch around JSON.parse for untrusted input — this is a valid boundary
- Error boundaries in React components — these are framework-prescribed patterns`,
  examples: [
    {
      label: "Untyped catch accessing error properties",
      scenario:
        "A function catches an error and accesses .message without narrowing the type.",
      bad: `try {
  await fetchData();
} catch (error) {
  logger.error(error.message);
  return { error: error.code };
}`,
      good: `try {
  await fetchData();
} catch (caughtError) {
  const message = caughtError instanceof Error
    ? caughtError.message
    : String(caughtError);
  logger.error(message);
  return { error: message };
}`,
      explanation:
        "The caught value may be a string, number, or undefined. Accessing .message on a non-Error value throws a TypeError, masking the original failure.",
    },
  ],
};
