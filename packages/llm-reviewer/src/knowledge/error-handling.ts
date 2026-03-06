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
  content: `Error handling becomes a structural problem when it tangles recovery logic with business logic. The refactoring concern is not "are errors caught properly?" but "does the error handling structure couple things that should be independent?"

Key structural anti-patterns:

1. Overly broad try blocks mixing concerns
Wrapping 30+ lines in a single try-catch when multiple independent operations could fail differently. This couples unrelated failure modes into one handler, making it impossible to recover from each appropriately. The fix is to narrow each try block to the single operation that can fail, or extract each fallible operation into its own function.

2. Error handling that hides responsibility violations
A function that catches errors from three different subsystems (database, API, file system) is doing too many things. The error handling is a symptom of an SRP violation — the function should be split so each piece handles its own failure mode.

3. Catch-and-rethrow chains that add no information
Catching an error just to wrap it in a new Error with a generic message and rethrow. This adds stack depth without adding diagnostic value. Either handle the error, add meaningful context via the cause property, or let it propagate.

When NOT to flag:
- catch blocks at the top-level request handler — this is the last-resort handler
- Defensive try-catch around JSON.parse for untrusted input — this is a valid boundary
- Error boundaries in React components — these are framework-prescribed patterns
- Do NOT suggest adding try-catch, null checks, or defensive validation to internal code`,
  examples: [
    {
      label: "Overly broad try block hiding mixed responsibilities",
      scenario:
        "A function wraps database access, business logic, and API call in one try-catch, coupling all failure modes.",
      bad: `async function processOrder(orderId: string) {
  try {
    const order = await db.orders.findUnique({ where: { id: orderId } });
    const tax = calculateTax(order);
    const discount = applyDiscount(order);
    await paymentApi.charge(order.customerId, tax + discount);
    await db.orders.update({ where: { id: orderId }, data: { status: "paid" } });
  } catch (error) {
    logger.error("Order processing failed", error);
    throw error;
  }
}`,
      good: `async function processOrder(orderId: string) {
  const order = await db.orders.findUnique({ where: { id: orderId } });
  if (!order) throw new OrderNotFoundError(orderId);

  const total = computeOrderTotal(order);

  try {
    await chargeCustomer(order.customerId, total);
  } catch (error) {
    throw new PaymentError(orderId, { cause: error });
  }

  await markOrderPaid(orderId);
}`,
      explanation:
        "Each concern has its own failure boundary. The database call propagates naturally, payment has a targeted catch that adds context via cause, and the pure computation has no error handling at all. Each failure mode is recoverable independently.",
    },
  ],
};
