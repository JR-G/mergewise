import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting side effects hidden inside pure transforms.
 *
 * @remarks
 * Draws from Command-Query Separation (Bertrand Meyer), functional programming
 * principles on referential transparency, and Martin Fowler's guidance on
 * separating queries from modifiers.
 */
export const SIDE_EFFECTS_PURITY_KNOWLEDGE: KnowledgeDocument = {
  id: "side-effects-purity",
  title: "Side Effects in Pure Transforms",
  category: "clean",
  triggerSignals: ["high_function_count"],
  triggerClassifications: [
    "side-effects",
    "mixed-responsibilities",
    "query-side-effect",
  ],
  fileExtensions: [],
  content: `A function whose name or signature implies a pure read — get, find, calculate, transform, format — but which also mutates state, writes to a database, sends events, or modifies its arguments violates Command-Query Separation. Callers treat it as safe to call freely, retry, or reorder, but each invocation triggers hidden writes.

Detection criteria:
- A function named get*, find*, calculate*, or format* that calls a write method (save, update, delete, emit, track, push)
- A transform or map callback that mutates the objects it iterates over rather than returning new ones
- A function that both returns a computed value and modifies module-level or closure-scoped state as a side channel
- Array or object utility functions that modify their arguments in place and also return the modified reference

The concrete cost:
- Callers cannot safely call a "getter" without triggering database writes, analytics events, or queue mutations — caching, retrying, or reordering calls changes system state
- The function cannot be unit-tested without mocking the side-effect targets (database, analytics, event bus), even though the caller only cares about the return value
- Pure computation is hidden behind I/O — extracting, reusing, or composing the calculation requires untangling the side effects first

Solutions:
- Command-Query Separation: split into a pure query that returns data and a separate command that performs the side effect
- Return values instead of mutating arguments — let the caller decide what to do with the result
- Separate the computation from the dispatch: compute the result, then call the side-effect function with the result as input
- For React, separate data-fetching hooks from state-mutation handlers

When NOT to flag:
- Functions at system boundaries that intentionally combine read and write as an atomic operation (e.g. dequeue, compareAndSwap, transaction handlers)
- Logging and instrumentation that is clearly observability infrastructure rather than business logic — provided it has no effect on control flow or return values
- Database transaction functions where atomicity requires read and write in the same scope`,
  examples: [
    {
      label: "getNextOrder that dequeues, updates status, and tracks analytics",
      scenario:
        "An order processing module has a getNextOrder function that callers treat as a read operation. Internally it dequeues from the queue, updates the order status to 'processing', and fires an analytics event — making it unsafe to call twice or use in tests without full infrastructure.",
      bad: `async function getNextOrder(queue: OrderQueue): Promise<Order | undefined> {
  const order = queue.dequeue();
  if (!order) {
    return undefined;
  }
  order.status = "processing";
  await database.orders.update(order.id, { status: order.status });
  analytics.track("order_started", { orderId: order.id });
  return order;
}`,
      good: `function peekNextOrder(queue: OrderQueue): Order | undefined {
  return queue.peek();
}

async function beginProcessing(order: Order): Promise<Order> {
  const updated = { ...order, status: "processing" as const };
  await database.orders.update(updated.id, { status: updated.status });
  analytics.track("order_started", { orderId: updated.id });
  return updated;
}`,
      explanation:
        "peekNextOrder is a pure query — safe to call repeatedly, trivial to test, and composable with other logic. beginProcessing is an explicit command whose side effects are visible in its name and signature. The caller decides when to transition from reading to mutating.",
    },
  ],
};
