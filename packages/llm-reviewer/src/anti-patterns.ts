/**
 * Typed catalogue of TS/React anti-patterns for the LLM reviewer.
 *
 * @remarks
 * Each entry includes `badExample`/`goodExample` for maintainer reference and a
 * compact `detectionHint` that is injected into the system prompt. The examples
 * are NOT sent to the LLM — only `id`, `title`, `category`, `principle`, and
 * `detectionHint` are serialised into the prompt as a markdown table.
 */

export interface AntiPattern {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: "clean" | "idiomatic" | "safety" | "perf";
  readonly languages: readonly ("typescript" | "react")[];
  readonly badExample: string;
  readonly goodExample: string;
  readonly principle: string;
  readonly detectionHint: string;
}

export const ANTI_PATTERNS: readonly AntiPattern[] = [
  // ── clean (5) ──────────────────────────────────────────────────────────

  {
    id: "god-component",
    title: "God component",
    description:
      "A single React component that handles multiple responsibilities — data fetching, state management, business logic, and rendering — making it hard to test and maintain.",
    category: "clean",
    languages: ["react"],
    badExample: `function Dashboard() {
  const [users, setUsers] = useState([]);
  const [metrics, setMetrics] = useState(null);
  useEffect(() => { fetchUsers().then(setUsers) }, []);
  useEffect(() => { fetchMetrics().then(setMetrics) }, []);
  const filtered = users.filter(u => u.active);
  const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
  return <div>{sorted.map(u => <Card key={u.id} user={u} />)}{metrics && <Chart data={metrics} />}</div>;
}`,
    goodExample: `function Dashboard() {
  const users = useActiveUsers();
  const metrics = useDashboardMetrics();
  return <DashboardLayout users={users} metrics={metrics} />;
}`,
    principle: "SRP",
    detectionHint:
      "Component with 3+ useState/useEffect hooks, inline data fetching, filtering/sorting logic, and direct rendering all in one body.",
  },

  {
    id: "mixed-concerns-component",
    title: "Mixed concerns in component",
    description:
      "Business logic (validation, transformation, computation) mixed directly into a React component instead of being extracted into hooks or pure functions.",
    category: "clean",
    languages: ["react"],
    badExample: `function OrderForm({ items }) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const tax = subtotal * 0.2;
  const discount = subtotal > 100 ? subtotal * 0.1 : 0;
  const total = subtotal + tax - discount;
  return <Summary total={total} />;
}`,
    goodExample: `function calculateOrderTotal(items) {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const tax = subtotal * 0.2;
  const discount = subtotal > 100 ? subtotal * 0.1 : 0;
  return subtotal + tax - discount;
}

function OrderForm({ items }) {
  const total = calculateOrderTotal(items);
  return <Summary total={total} />;
}`,
    principle: "SRP — separate computation from presentation",
    detectionHint:
      "Non-trivial arithmetic, string manipulation, or business rules computed inline inside a component body rather than in a helper or hook.",
  },

  {
    id: "options-object-mutation",
    title: "Options object mutation",
    description:
      "Mutating an options/config object that was passed in as a parameter, causing subtle bugs for callers who share the reference.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function applyDefaults(opts: Options) {
  opts.timeout ??= 3000;
  opts.retries ??= 3;
  return opts;
}`,
    goodExample: `function applyDefaults(opts: Options): Options {
  return { timeout: 3000, retries: 3, ...opts };
}`,
    principle: "Immutability — never mutate shared references",
    detectionHint:
      "Direct property assignment on a function parameter object (param.x = ...) instead of spreading into a new object.",
  },

  {
    id: "boolean-flag-parameter",
    title: "Boolean flag parameter",
    description:
      "A function that accepts a boolean to toggle between two behaviours, making call sites unreadable and the function do two things.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function getUsers(includeInactive: boolean) {
  if (includeInactive) return db.users.findAll();
  return db.users.findActive();
}
getUsers(true);`,
    goodExample: `function getActiveUsers() { return db.users.findActive(); }
function getAllUsers() { return db.users.findAll(); }`,
    principle: "SRP — a function should do one thing",
    detectionHint:
      "Function with a boolean parameter that controls an if/else branch selecting between two distinct behaviours. Call sites pass literal true/false.",
  },

  {
    id: "deeply-nested-callbacks",
    title: "Deeply nested callbacks",
    description:
      "Three or more levels of nested callbacks or promise chains making control flow hard to follow.",
    category: "clean",
    languages: ["typescript"],
    badExample: `fetchUser(id, (user) => {
  fetchOrders(user.id, (orders) => {
    fetchItems(orders[0].id, (items) => {
      render(items);
    });
  });
});`,
    goodExample: `const user = await fetchUser(id);
const orders = await fetchOrders(user.id);
const items = await fetchItems(orders[0].id);
render(items);`,
    principle: "KISS — flatten control flow",
    detectionHint:
      "3+ levels of nested function expressions, arrow functions, or .then() chains. Look for increasing indentation with callback parameters.",
  },

  // ── idiomatic (6) ──────────────────────────────────────────────────────

  {
    id: "derived-state-as-use-state",
    title: "Derived state stored in useState",
    description:
      "Using useState + useEffect to compute a value that could be derived directly from existing state or props during render.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [items, setItems] = useState(props.items);
const [filtered, setFiltered] = useState([]);
useEffect(() => {
  setFiltered(items.filter(i => i.active));
}, [items]);`,
    goodExample: `const filtered = props.items.filter(i => i.active);`,
    principle: "Derive, don't sync",
    detectionHint:
      "useState + useEffect pair where the effect only calls a setState with a value computable from props or other state. The derived value never has independent mutations.",
  },

  {
    id: "stale-closure-in-effect",
    title: "Stale closure in useEffect",
    description:
      "A useEffect that references state or props but omits them from the dependency array, reading stale values.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [count, setCount] = useState(0);
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, []);`,
    goodExample: `const [count, setCount] = useState(0);
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  return () => clearInterval(id);
}, []);`,
    principle: "Hooks rules — exhaustive deps",
    detectionHint:
      "useEffect/useCallback/useMemo body references a variable from component scope that is absent from the dependency array.",
  },

  {
    id: "useeffect-as-event-handler",
    title: "useEffect as event handler",
    description:
      "Using useEffect to respond to a user action (click, submit) instead of handling it directly in the event handler.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `const [submitted, setSubmitted] = useState(false);
useEffect(() => {
  if (submitted) { sendData(formData); }
}, [submitted]);
const handleSubmit = () => setSubmitted(true);`,
    goodExample: `const handleSubmit = () => { sendData(formData); };`,
    principle: "Effects are for synchronisation, not events",
    detectionHint:
      "useEffect triggered by a boolean flag state that is set in an event handler. The effect body performs a one-shot action (API call, navigation).",
  },

  {
    id: "prop-drilling",
    title: "Prop drilling",
    description:
      "Passing props through multiple intermediate components that do not use them, just to reach a deeply nested child.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `function App({ theme }) {
  return <Layout theme={theme} />;
}
function Layout({ theme }) {
  return <Sidebar theme={theme} />;
}
function Sidebar({ theme }) {
  return <NavItem theme={theme} />;
}`,
    goodExample: `const ThemeContext = createContext<Theme>(defaultTheme);
function App({ theme }) {
  return <ThemeContext.Provider value={theme}><Layout /></ThemeContext.Provider>;
}
function NavItem() {
  const theme = useContext(ThemeContext);
}`,
    principle: "Prefer context or composition for cross-cutting concerns",
    detectionHint:
      "Same prop name passed through 3+ component levels without being used in intermediate components. Intermediate components just forward the prop.",
  },

  {
    id: "class-based-component",
    title: "New class-based React component",
    description:
      "Introducing a new class component when function components with hooks are the idiomatic standard.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `class UserCard extends React.Component<Props> {
  render() {
    return <div>{this.props.name}</div>;
  }
}`,
    goodExample: `function UserCard({ name }: Props) {
  return <div>{name}</div>;
}`,
    principle: "Idiomatic React — prefer function components",
    detectionHint:
      "New class extending React.Component or React.PureComponent in added lines (not legacy code being modified).",
  },

  {
    id: "object-spread-for-optional-props",
    title: "Spread operator for optional prop forwarding",
    description:
      "Using object spread to forward all props to a child, making the component API opaque and fragile.",
    category: "idiomatic",
    languages: ["react"],
    badExample: `function Button({ label, ...rest }: ButtonProps) {
  return <button {...rest}>{label}</button>;
}`,
    goodExample: `function Button({ label, onClick, disabled, className }: ButtonProps) {
  return <button onClick={onClick} disabled={disabled} className={className}>{label}</button>;
}`,
    principle: "Explicit interfaces — name what you pass",
    detectionHint:
      "Rest spread (...rest or ...props) destructured from component parameters and spread onto a JSX element.",
  },

  // ── safety (3) ─────────────────────────────────────────────────────────

  {
    id: "overly-wide-generic",
    title: "Overly wide generic constraint",
    description:
      "A generic type parameter constrained to a very wide type (object, Record<string, unknown>, any) that provides no meaningful type narrowing.",
    category: "safety",
    languages: ["typescript"],
    badExample: `function merge<T extends object>(a: T, b: T): T {
  return { ...a, ...b };
}`,
    goodExample: `function merge<T extends Record<string, unknown>>(
  a: T, b: Partial<T>
): T {
  return { ...a, ...b };
}`,
    principle: "Type safety — constrain generics to the narrowest useful bound",
    detectionHint:
      "Generic parameter with 'extends object', 'extends {}', 'extends any', or 'extends Record<string, any>' where a narrower constraint exists.",
  },

  {
    id: "implicit-any-in-catch",
    title: "Implicit any in catch clause",
    description:
      "Using the caught error as if it were a typed Error instance without narrowing, risking runtime TypeError if a non-Error is thrown.",
    category: "safety",
    languages: ["typescript"],
    badExample: `try { riskyOp(); }
catch (err) {
  console.error(err.message);
  throw new AppError(err.code);
}`,
    goodExample: `try { riskyOp(); }
catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new AppError(message);
}`,
    principle: "Defensive typing — unknown over any in catch",
    detectionHint:
      "Catch clause accessing .message, .code, .stack, or other properties on the error parameter without an instanceof or typeof guard.",
  },

  {
    id: "inconsistent-absent-value",
    title: "Inconsistent absent value representation",
    description:
      "Mixing null and undefined to represent absence within the same interface or function, causing confusing equality checks.",
    category: "safety",
    languages: ["typescript"],
    badExample: `interface User {
  name: string;
  email: string | null;
  phone?: string;
  address: string | undefined;
}`,
    goodExample: `interface User {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}`,
    principle: "Consistency — pick one absent-value convention",
    detectionHint:
      "Same interface or type using both '| null' and '?' (optional) or '| undefined' for fields that all represent 'no value'.",
  },

  // ── perf (4) ───────────────────────────────────────────────────────────

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
] as const;
