import type { AntiPattern } from "./anti-pattern-types";

export const PERF_PATTERNS: readonly AntiPattern[] = [
  {
    id: "expensive-computation-in-render",
    title: "Expensive computation in render path",
    description:
      "Running a costly operation (sort, filter over large array, deep clone, regex compilation) on every render without memoisation.",
    category: "perf",
    languages: ["react"],
    badExample: `function UserList({ users }) {
  const sorted = [...users].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(u => <UserRow key={u.id} user={u} />);
}`,
    goodExample: `function UserList({ users }) {
  const sorted = useMemo(
    () => [...users].sort((a, b) => a.name.localeCompare(b.name)),
    [users]
  );
  return sorted.map(u => <UserRow key={u.id} user={u} />);
}`,
    principle: "Memoise expensive derived values",
    detectionHint:
      "Array.sort(), .filter(), .reduce(), structuredClone, JSON.parse(JSON.stringify(...)), or regex construction directly in component body without useMemo.",
  },

  {
    id: "missing-use-callback-handler",
    title: "Inline handler in memoised child",
    description:
      "Passing an inline arrow function as a prop to a React.memo child, defeating memoisation because the reference changes every render.",
    category: "perf",
    languages: ["react"],
    badExample: `const MemoChild = React.memo(Child);
function Parent() {
  return <MemoChild onClick={() => doSomething()} />;
}`,
    goodExample: `const MemoChild = React.memo(Child);
function Parent() {
  const handleClick = useCallback(() => doSomething(), []);
  return <MemoChild onClick={handleClick} />;
}`,
    principle: "Stable references for memoised children",
    detectionHint:
      "Inline arrow function or function expression passed as prop to a component wrapped in React.memo or known to be memoised.",
  },

  {
    id: "missing-react-memo",
    title: "Missing React.memo on pure presentational component",
    description:
      "A stateless presentational component that renders frequently due to parent re-renders but is not wrapped in React.memo.",
    category: "perf",
    languages: ["react"],
    badExample: `function ExpensiveRow({ data }: Props) {
  return (
    <tr>{data.columns.map(c => <td key={c.id}>{format(c.value)}</td>)}</tr>
  );
}`,
    goodExample: `const ExpensiveRow = React.memo(function ExpensiveRow({ data }: Props) {
  return (
    <tr>{data.columns.map(c => <td key={c.id}>{format(c.value)}</td>)}</tr>
  );
});`,
    principle: "Memoise leaf components rendered in lists",
    detectionHint:
      "Stateless component rendered inside .map() or a list without React.memo wrapping. Especially relevant when the component does non-trivial work (formatting, computation).",
  },

  {
    id: "new-object-in-context-value",
    title: "New object literal as context value",
    description:
      "Passing a new object literal as a context provider value, causing all consumers to re-render on every provider render.",
    category: "perf",
    languages: ["react"],
    badExample: `function ThemeProvider({ children }) {
  const [mode, setMode] = useState("light");
  return (
    <ThemeContext.Provider value={{ mode, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}`,
    goodExample: `function ThemeProvider({ children }) {
  const [mode, setMode] = useState("light");
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}`,
    principle: "Stable context values — memoise provider objects",
    detectionHint:
      "Object literal or array literal passed directly as the value prop of a Context.Provider without useMemo.",
  },
];
