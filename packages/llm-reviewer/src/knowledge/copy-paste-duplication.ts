import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting copy-paste duplication and repeated handlers.
 *
 * @remarks
 * Draws from DRY (Andy Hunt and Dave Thomas, The Pragmatic Programmer),
 * the Rule of Three, and Martin Fowler's refactoring catalogue on
 * duplicated code and parameterised extraction.
 */
export const COPY_PASTE_DUPLICATION_KNOWLEDGE: KnowledgeDocument = {
  id: "copy-paste-duplication",
  title: "Copy-Paste Duplication and Repeated Handlers",
  category: "clean",
  triggerSignals: ["high_function_count", "large_function"],
  triggerClassifications: [
    "duplication",
    "mixed-responsibilities",
    "copy-paste",
  ],
  fileExtensions: [],
  content: `Copy-paste duplication occurs when multiple functions or handlers share near-identical structure, differing only in a handful of values — field names, endpoint URLs, validation messages, or event types. The duplicated logic is often introduced under time pressure: a developer copies a working handler, changes the specifics, and moves on.

Detection criteria:
- Three or more functions in the same file with the same control-flow skeleton (fetch → validate → transform → persist) differing only in string literals or field references
- Repeated event-listener registrations that bind near-identical callbacks
- Validation blocks that check the same shape of rules against different fields with identical error-handling logic
- API call patterns where the URL, method, and response mapping are the only differences

The concrete cost:
- Fixing a bug in one copy requires finding and patching every copy — miss one and you ship an inconsistent fix
- Adding a step to one handler (e.g. audit logging, rate limiting) means adding it to all copies, or risk silent divergence
- Reviewers cannot tell whether structural differences between copies are intentional or accidental drift

Solutions:
- Extract the shared skeleton into a parameterised function that accepts the varying parts as arguments or a configuration object
- Use a lookup table or record mapping discriminator values to their specific configuration, then iterate or dispatch
- Register handlers in a loop over the configuration entries rather than writing each registration by hand
- For React, extract a generic component that accepts props for the varying parts

When NOT to flag:
- Code that looks structurally similar but follows genuinely different logic paths — the similarity is coincidental
- Two copies only — the Rule of Three applies; premature extraction of two instances often creates unnecessary abstraction
- Test fixtures that intentionally duplicate setup for clarity — merging them harms readability and makes failures harder to diagnose`,
  examples: [
    {
      label: "Three near-identical form handlers extracted into a shared factory",
      scenario:
        "A React form component has three submit handlers for different entity types (user, project, team). Each handler validates, submits to an API, shows a toast, and resets the form — differing only in the endpoint, payload shape, and success message.",
      bad: `async function handleUserSubmit(values: UserForm) {
  const errors = validateRequired(values, ["name", "email"]);
  if (errors.length > 0) {
    setFieldErrors(errors);
    return;
  }
  await fetch("/api/users", { method: "POST", body: JSON.stringify(values) });
  toast.success("User created");
  resetForm();
}

async function handleProjectSubmit(values: ProjectForm) {
  const errors = validateRequired(values, ["title", "owner"]);
  if (errors.length > 0) {
    setFieldErrors(errors);
    return;
  }
  await fetch("/api/projects", { method: "POST", body: JSON.stringify(values) });
  toast.success("Project created");
  resetForm();
}

async function handleTeamSubmit(values: TeamForm) {
  const errors = validateRequired(values, ["name", "lead"]);
  if (errors.length > 0) {
    setFieldErrors(errors);
    return;
  }
  await fetch("/api/teams", { method: "POST", body: JSON.stringify(values) });
  toast.success("Team created");
  resetForm();
}`,
      good: `interface FormHandlerConfig<T extends Record<string, unknown>> {
  endpoint: string;
  requiredFields: Array<keyof T & string>;
  successMessage: string;
}

function createSubmitHandler<T extends Record<string, unknown>>(
  config: FormHandlerConfig<T>,
  setFieldErrors: (errors: string[]) => void,
  resetForm: () => void,
) {
  return async (values: T) => {
    const errors = validateRequired(values, config.requiredFields);
    if (errors.length > 0) {
      setFieldErrors(errors);
      return;
    }
    await fetch(config.endpoint, { method: "POST", body: JSON.stringify(values) });
    toast.success(config.successMessage);
    resetForm();
  };
}

const handleUserSubmit = createSubmitHandler<UserForm>(
  { endpoint: "/api/users", requiredFields: ["name", "email"], successMessage: "User created" },
  setFieldErrors,
  resetForm,
);`,
      explanation:
        "The shared skeleton (validate → fetch → toast → reset) is written once. Adding audit logging or error handling applies to all entity types automatically. New entity types require only a configuration entry, not a new function.",
    },
  ],
};
