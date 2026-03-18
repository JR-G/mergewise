import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting deeply nested conditionals and complex boolean logic.
 *
 * @remarks
 * Draws from Martin Fowler's "Replace Nested Conditional with Guard Clauses",
 * Robert C. Martin's guidance on function structure, and Kent Beck's
 * "Smalltalk Best Practice Patterns" on composed methods.
 */
export const NESTED_CONDITIONALS_KNOWLEDGE: KnowledgeDocument = {
  id: "nested-conditionals",
  title: "Nested Conditionals and Complex Boolean Logic",
  category: "clean",
  triggerSignals: ["high_nesting", "large_function"],
  triggerClassifications: [
    "nested-conditionals",
    "complex-boolean",
    "god-function-growth",
  ],
  fileExtensions: [],
  content: `Deeply nested if/else chains force the reader to hold the full nesting context in working memory to understand any single branch. Each additional nesting level roughly doubles the cognitive load because you must track which conditions are true and which are false to reach that point.

Detection criteria:
- Three or more levels of nested if/else or if/else-if blocks within a single function
- Boolean expressions with 3+ clauses joined by mixed && and || operators without extraction into named predicates
- Functions where the "happy path" is buried inside multiple layers of precondition checks
- Conditional blocks where the if and else branches are both substantial (neither is a simple guard return)

Flattening techniques:
- Guard clauses: check for the abnormal case and return early, leaving the happy path at the top indentation level
- Named predicates: extract complex boolean expressions into well-named functions or constants that describe the business intent
- Lookup tables or maps: replace chains of if/else-if that check the same variable against different values
- Polymorphism: when branching on a type discriminator, move each branch into a method on the corresponding type

When NOT to flag:
- Exhaustive switch/case or pattern matching where each branch is a single expression — the structure aids readability
- Simple ternary expressions used for assignment or return values
- Validation chains that are already short (2-3 lines each) and clearly sequential
- Functions under ~15 lines where the nesting is shallow and the branches are trivial

The concrete cost must be specific: "Adding a new user role requires tracing through 4 levels of nesting to find the correct insertion point" or "A change to the else branch on line 45 silently breaks the sibling branch on line 32 because they share a mutable local declared 20 lines above."`,
  examples: [
    {
      label: "Nested if-else chain flattened with guard clauses",
      scenario:
        "A request handler checks authentication, authorisation, input validity, and rate limits with nested if/else blocks before executing the actual logic.",
      bad: `async function handleUpdateProfile(request: Request): Promise<Response> {
  const session = await getSession(request);
  if (session) {
    const user = await findUser(session.userId);
    if (user) {
      if (user.role === "admin" || user.id === request.params.targetId) {
        const body = await parseBody(request);
        if (body && isValidProfile(body)) {
          const updated = await updateProfile(user.id, body);
          if (updated) {
            return new Response(JSON.stringify(updated), { status: 200 });
          } else {
            return new Response("Update failed", { status: 500 });
          }
        } else {
          return new Response("Invalid input", { status: 400 });
        }
      } else {
        return new Response("Forbidden", { status: 403 });
      }
    } else {
      return new Response("User not found", { status: 404 });
    }
  } else {
    return new Response("Unauthorised", { status: 401 });
  }
}`,
      good: `async function handleUpdateProfile(request: Request): Promise<Response> {
  const session = await getSession(request);
  if (!session) {
    return new Response("Unauthorised", { status: 401 });
  }

  const user = await findUser(session.userId);
  if (!user) {
    return new Response("User not found", { status: 404 });
  }

  const canEdit = user.role === "admin" || user.id === request.params.targetId;
  if (!canEdit) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = await parseBody(request);
  if (!body || !isValidProfile(body)) {
    return new Response("Invalid input", { status: 400 });
  }

  const updated = await updateProfile(user.id, body);
  if (!updated) {
    return new Response("Update failed", { status: 500 });
  }

  return new Response(JSON.stringify(updated), { status: 200 });
}`,
      explanation:
        "Each guard clause exits early for one failure mode. The happy path reads top to bottom at a single indentation level. Adding a new precondition (e.g. rate limiting) is a one-line insertion rather than a restructuring of the entire nesting tree.",
    },
    {
      label: "Complex boolean condition extracted into named predicate",
      scenario:
        "A notification service decides whether to send an alert based on a compound boolean expression mixing user preferences, quiet hours, and severity thresholds.",
      bad: `function shouldSendAlert(event: AlertEvent, preferences: UserPreferences): boolean {
  if (
    event.severity >= preferences.minSeverity &&
    !preferences.mutedCategories.includes(event.category) &&
    !(preferences.quietHoursEnabled &&
      event.timestamp.getHours() >= preferences.quietStart &&
      event.timestamp.getHours() < preferences.quietEnd) &&
    (preferences.channels.length > 0 || event.severity >= Severity.Critical)
  ) {
    return true;
  }
  return false;
}`,
      good: `function meetsMinimumSeverity(event: AlertEvent, preferences: UserPreferences): boolean {
  return event.severity >= preferences.minSeverity;
}

function isCategoryMuted(event: AlertEvent, preferences: UserPreferences): boolean {
  return preferences.mutedCategories.includes(event.category);
}

function isDuringQuietHours(event: AlertEvent, preferences: UserPreferences): boolean {
  if (!preferences.quietHoursEnabled) {
    return false;
  }
  const hour = event.timestamp.getHours();
  return hour >= preferences.quietStart && hour < preferences.quietEnd;
}

function hasAvailableChannel(event: AlertEvent, preferences: UserPreferences): boolean {
  return preferences.channels.length > 0 || event.severity >= Severity.Critical;
}

function shouldSendAlert(event: AlertEvent, preferences: UserPreferences): boolean {
  if (!meetsMinimumSeverity(event, preferences)) {
    return false;
  }
  if (isCategoryMuted(event, preferences)) {
    return false;
  }
  if (isDuringQuietHours(event, preferences)) {
    return false;
  }
  return hasAvailableChannel(event, preferences);
}`,
      explanation:
        "Each predicate is independently testable and its name communicates intent. When a bug report says 'I received an alert during quiet hours', you know exactly which predicate to investigate without parsing a compound boolean expression.",
    },
  ],
};
