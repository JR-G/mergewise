import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting god functions and god components.
 *
 * @remarks
 * Draws from SRP (Robert C. Martin), the Tao of React (Alex Kondov) on
 * component size and extracting helper components, and general refactoring
 * guidance on function decomposition.
 */
export const GOD_FUNCTION_KNOWLEDGE: KnowledgeDocument = {
  id: "god-function",
  title: "God Function and God Component Detection",
  category: "clean",
  triggerSignals: ["high_function_count", "large_function", "large_component"],
  triggerClassifications: [
    "god-function-growth",
    "mixed-responsibilities",
    "component-complexity",
  ],
  fileExtensions: [],
  content: `A god function or god component accumulates multiple unrelated responsibilities behind a single entry point. The engineering cost is not size itself — it is that changes to one responsibility force you to understand and risk breaking the others.

Detection criteria:
- A function that fetches data, transforms it, and renders/returns it in the same scope
- A component that manages 3+ pieces of independent state (each with its own lifecycle)
- A function where the top half and bottom half could be tested independently but cannot because they share mutable locals
- A handler that mixes validation, business logic, persistence, and response formatting

When NOT to flag:
- Orchestrator functions that delegate to well-named helpers and contain no logic of their own
- Pipeline functions where each step is a single expression (map/filter/reduce chains)
- Functions under ~30 lines even if they touch multiple concerns — the cost of extraction exceeds the benefit
- Test setup functions that configure multiple mocks — these are inherently multi-concern

The concrete cost must be specific: "You cannot test the sorting logic without also setting up the fetch mock" or "Adding a new filter requires reading through 80 lines of unrelated validation."`,
  examples: [
    {
      label: "Dashboard component doing fetch, sort, and render",
      scenario:
        "A React component that fetches users, sorts them, filters by status, and renders a table — all in one function body.",
      bad: `function Dashboard() {
  const [users, setUsers] = useState([]);
  const [sortKey, setSortKey] = useState("name");
  const [filter, setFilter] = useState("active");

  useEffect(() => {
    fetch("/api/users").then(r => r.json()).then(setUsers);
  }, []);

  const sorted = [...users].sort((a, b) => a[sortKey].localeCompare(b[sortKey]));
  const filtered = sorted.filter(u => u.status === filter);

  return <Table data={filtered} onSort={setSortKey} onFilter={setFilter} />;
}`,
      good: `function Dashboard() {
  const users = useUsers();
  const { sorted, setSortKey } = useSorted(users, "name");
  const { filtered, setFilter } = useFiltered(sorted, "active");

  return <Table data={filtered} onSort={setSortKey} onFilter={setFilter} />;
}`,
      explanation:
        "Each concern (fetching, sorting, filtering) is independently testable. Adding a new sort algorithm does not require mocking the fetch layer.",
    },
  ],
};
