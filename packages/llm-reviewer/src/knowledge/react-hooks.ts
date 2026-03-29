import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for React hook anti-patterns and idioms.
 *
 * @remarks
 * Draws from the Tao of React (Alex Kondov) on preferring hooks over HOCs,
 * the React documentation on hook rules, and the mkosir TypeScript style
 * guide on derived state and props-to-state patterns.
 */
export const REACT_HOOKS_KNOWLEDGE: KnowledgeDocument = {
  id: "react-hooks",
  title: "React Hook Rules and Anti-Patterns",
  category: "idiomatic",
  triggerSignals: ["has_hooks", "high_hook_count"],
  triggerClassifications: [
    "state-management",
    "new-react-component",
    "hook-misuse",
  ],
  fileExtensions: [".tsx", ".jsx"],
  content: `React hooks encode component lifecycle as composable functions. Misusing them creates bugs that are invisible at review time but surface as stale renders, infinite loops, or unnecessary re-renders in production.

Key anti-patterns:

1. Derived state stored in useState + useEffect
When a value can be computed from existing props or state, storing it in separate state and syncing via useEffect creates a render cycle: render with stale value → effect fires → setState → re-render with correct value. The fix is a const or useMemo.

2. Stale closures in useEffect
An effect that reads state or props but omits them from the dependency array captures the value from the render where the effect was created, not the current render. This creates subtle bugs where the effect operates on outdated data.

3. useEffect as an event handler
Using a boolean flag in state (e.g. shouldSubmit) plus a useEffect watching that flag to trigger a one-shot action (API call, navigation). This is an event handler disguised as a lifecycle hook. Call the action directly in the event handler instead.

4. Too many useState calls
When a component has 4+ useState calls managing related state, useReducer provides a single state transition function that is easier to test and reason about. From the Tao of React: reach for useReducer before external state libraries.

5. Props drilled through 3+ levels
When a prop passes through intermediate components that do not use it, it couples those components to the data shape. Use context or composition (children) to skip intermediate layers.

6. Unstable context provider values
Passing an inline object literal as a Context.Provider value creates a new reference on every render, which forces every consumer to re-render even when the underlying values are unchanged. If the value object includes callbacks created inline, stabilise them with useCallback and memoise the provider value with useMemo.

When NOT to flag:
- A single useState for a simple toggle or input value
- useEffect for genuine side effects (subscriptions, event listeners, data fetching with cleanup)
- Custom hooks that encapsulate a single useState + useEffect pair — these ARE the extraction
- Converting a simple class component to a function component when the real issue is prop drilling or provider stability elsewhere in the diff`,
  examples: [
    {
      label: "Derived state via useState + useEffect",
      scenario:
        "A component computes a filtered list from props using useState and useEffect instead of a direct computation.",
      bad: `function UserList({ users, filter }) {
  const [filtered, setFiltered] = useState([]);
  useEffect(() => {
    setFiltered(users.filter(u => u.role === filter));
  }, [users, filter]);
  return <List items={filtered} />;
}`,
      good: `function UserList({ users, filter }) {
  const filtered = useMemo(
    () => users.filter(u => u.role === filter),
    [users, filter],
  );
  return <List items={filtered} />;
}`,
      explanation:
        "The useState + useEffect version renders twice per change: once with stale data, once after the effect. useMemo computes the value synchronously during render.",
    },
    {
      label: "useEffect as event handler",
      scenario:
        "A component uses a boolean flag to trigger form submission via useEffect.",
      bad: `const [shouldSubmit, setShouldSubmit] = useState(false);
useEffect(() => {
  if (shouldSubmit) {
    submitForm(data);
    setShouldSubmit(false);
  }
}, [shouldSubmit, data]);`,
      good: `function handleSubmit() {
  submitForm(data);
}`,
      explanation:
        "The useEffect version entangles render lifecycle with user action. The direct handler is simpler to trace and does not risk re-firing on unrelated re-renders.",
    },
    {
      label: "Unstable provider value",
      scenario:
        "A context provider recreates its value object on every render, causing all consumers to re-render even when only the provider itself changed.",
      bad: `function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const login = (nextUser) => setUser(nextUser);
  return (
    <AuthContext.Provider value={{ user, login }}>
      {children}
    </AuthContext.Provider>
  );
}`,
      good: `function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const login = useCallback((nextUser) => setUser(nextUser), []);
  const value = useMemo(() => ({ user, login }), [user, login]);
  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}`,
      explanation:
        "The inline object forces every consumer to re-render on each provider render because the reference changes every time. Stabilising the callback and memoising the value preserves consumer bailout opportunities.",
    },
  ],
};
