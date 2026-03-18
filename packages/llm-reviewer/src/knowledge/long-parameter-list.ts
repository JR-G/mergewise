import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting functions with excessively long parameter lists.
 *
 * @remarks
 * Draws from Martin Fowler's "Introduce Parameter Object" refactoring,
 * Robert C. Martin's guidance on function arguments in Clean Code, and
 * TypeScript-specific patterns for options objects.
 */
export const LONG_PARAMETER_LIST_KNOWLEDGE: KnowledgeDocument = {
  id: "long-parameter-list",
  title: "Long Parameter Lists",
  category: "clean",
  triggerSignals: ["high_param_count"],
  triggerClassifications: ["interface-change", "long-parameter-list"],
  fileExtensions: [],
  content: `Functions with five or more parameters — especially when several describe the same conceptual entity — produce call sites that are difficult to read and fragile to change. Positional arguments provide no indication of which value maps to which parameter, and adding a new parameter is a breaking change for every caller.

Detection criteria:
- A function signature has 5+ parameters
- Multiple adjacent parameters share the same type (e.g. three consecutive strings), making it easy to transpose arguments at call sites without a type error
- Several parameters clearly belong to the same domain entity (e.g. firstName, lastName, email, phone all describe a user)
- The function is called from multiple sites, amplifying the cost of any signature change

Refactoring approaches:
- Parameter object / options interface: group related parameters into a named interface. Call sites use named properties, making transposition impossible and additions non-breaking.
- Builder pattern: for complex configuration with many optional fields, a builder provides a fluent API with compile-time safety
- Partial application: when some parameters are fixed for a given context, create a partially-applied wrapper that closes over them

When NOT to flag:
- Well-known API shapes with standard signatures (e.g. event handlers receiving event, context, callback)
- Functions where every parameter is a different type and genuinely independent — the type system already prevents transposition
- Internal functions called from exactly one site where the signature is trivially visible
- Callback signatures imposed by a framework or library (e.g. Express middleware, React lifecycle)

The concrete cost must be specific: "Call sites pass 7 positional strings — swapping email and phone produces no type error but sends notifications to the wrong address" or "Adding a middle name field requires updating 12 call sites across 8 files."`,
  examples: [
    {
      label:
        "User creation with positional parameters refactored to options object",
      scenario:
        "A createUser function accepts seven positional parameters, several of which are strings. Call sites are unreadable and a new optional field requires changing every caller.",
      bad: `async function createUser(
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
  role: string,
  departmentId: string,
  managerId: string | null
): Promise<User> {
  validateEmail(email);
  validatePhone(phone);

  return await db.user.create({
    data: {
      firstName,
      lastName,
      email,
      phone,
      role,
      departmentId,
      managerId,
    },
  });
}

const user = await createUser(
  "Jane",
  "Smith",
  "jane@example.com",
  "+44 7700 900000",
  "engineer",
  "dept-42",
  "mgr-7"
);`,
      good: `interface CreateUserOptions {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: string;
  departmentId: string;
  managerId: string | null;
}

async function createUser(options: CreateUserOptions): Promise<User> {
  validateEmail(options.email);
  validatePhone(options.phone);

  return await db.user.create({ data: options });
}

const user = await createUser({
  firstName: "Jane",
  lastName: "Smith",
  email: "jane@example.com",
  phone: "+44 7700 900000",
  role: "engineer",
  departmentId: "dept-42",
  managerId: "mgr-7",
});`,
      explanation:
        "Named properties at the call site make it impossible to accidentally swap email and phone. Adding a new optional field (e.g. middleName) only requires updating callers that provide it. The interface serves as living documentation of the function's contract.",
    },
  ],
};
