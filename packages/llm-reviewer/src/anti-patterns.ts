/**
 * Typed catalogue of TS/React anti-patterns for the LLM reviewer.
 *
 * @remarks
 * Each entry includes `badExample`/`goodExample` for maintainer reference and a
 * compact `detectionHint` that is injected into the system prompt. The examples
 * are NOT sent to the LLM — only `id`, `title`, `category`, `principle`, and
 * `detectionHint` are serialised into the prompt as a markdown table.
 */

/**
 * A documented anti-pattern entry for the LLM reviewer catalogue.
 *
 * @remarks
 * Each entry pairs human-readable documentation (`badExample`/`goodExample`)
 * with a compact `detectionHint` that is injected into the system prompt.
 * Only `id`, `title`, `category`, `principle`, and `detectionHint` are
 * serialised into the prompt — the examples are for maintainer reference only.
 */
export interface AntiPattern {
  /** Unique kebab-case identifier, referenced in LLM findings. */
  readonly id: string;
  /** Short human-readable name for the anti-pattern. */
  readonly title: string;
  /** Longer explanation of why this pattern is problematic. */
  readonly description: string;
  /** Review focus area this pattern belongs to. */
  readonly category: "clean" | "idiomatic" | "safety" | "perf";
  /** Languages this pattern applies to. */
  readonly languages: readonly ("typescript" | "react")[];
  /** Illustrative code showing the anti-pattern. Not sent to the LLM. */
  readonly badExample: string;
  /** Refactored alternative. Not sent to the LLM. */
  readonly goodExample: string;
  /** Named principle or rule violated (e.g. "SRP", "DRY"). */
  readonly principle: string;
  /** Compact description injected into the system prompt to guide detection. */
  readonly detectionHint: string;
}

const CLEAN_PATTERNS: readonly AntiPattern[] = [
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
    id: "imperative-loop-over-array",
    title: "Imperative loop over array",
    description:
      "A for or for-of loop that builds a new array via push or accumulates a value, where .map(), .filter(), .reduce(), or .flatMap() would express the same intent declaratively.",
    category: "clean",
    languages: ["typescript"],
    badExample: `const names = [];
for (const u of users) {
  if (u.active) names.push(u.name);
}`,
    goodExample: `const names = users.filter(u => u.active).map(u => u.name);`,
    principle: "Prefer declarative transforms over imperative loops",
    detectionHint:
      "for/for-of loop that builds a new array via push(), or accumulates a value, where .map(), .filter(), .reduce(), or .flatMap() would express the same intent declaratively.",
  },

  {
    id: "mutable-accumulator",
    title: "Mutable accumulator",
    description:
      "A let variable declared before a loop and mutated inside it (counter, string concatenation, object building) where a reduce, join, or Object.fromEntries would be clearer.",
    category: "clean",
    languages: ["typescript"],
    badExample: `let total = 0;
for (const item of items) {
  total += item.price;
}`,
    goodExample: `const total = items.reduce((sum, item) => sum + item.price, 0);`,
    principle: "Prefer reduce/Object.fromEntries over mutable accumulation",
    detectionHint:
      "let variable declared before a loop and mutated inside it (counter, string concatenation, object building) where a reduce, join, or Object.fromEntries would be clearer.",
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

  {
    id: "switch-on-type",
    title: "Switch/if-else chain on type discriminator",
    description:
      "A large switch or if-else chain that dispatches behaviour based on a type or kind discriminator. Each new variant forces edits to the switch rather than adding a new handler, violating Open/Closed.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function processShape(shape: Shape) {
  switch (shape.kind) {
    case "circle": return Math.PI * shape.radius ** 2;
    case "rect": return shape.width * shape.height;
    case "triangle": return 0.5 * shape.base * shape.height;
    case "ellipse": return Math.PI * shape.a * shape.b;
    // every new shape means another case here
  }
}`,
    goodExample: `const areaStrategy: Record<Shape["kind"], (s: Shape) => number> = {
  circle: (s) => Math.PI * s.radius ** 2,
  rect: (s) => s.width * s.height,
  triangle: (s) => 0.5 * s.base * s.height,
  ellipse: (s) => Math.PI * s.a * s.b,
};

function processShape(shape: Shape) {
  return areaStrategy[shape.kind](shape);
}`,
    principle: "Open/Closed — extend via a lookup map, not by editing a switch",
    detectionHint:
      "switch or if-else chain with 4+ branches dispatching on a .type, .kind, or string-literal discriminator where each branch runs distinct logic. Look for a pattern of case/if testing the same discriminant property.",
  },

  {
    id: "manual-object-construction",
    title: "Repetitive manual object construction",
    description:
      "Multiple blocks of code that manually assemble similar objects with the same shape, differing only in values. A factory function or builder would reduce duplication and enforce consistency.",
    category: "clean",
    languages: ["typescript"],
    badExample: `const adminUser = {
  role: "admin",
  permissions: ["read", "write", "delete"],
  createdAt: new Date(),
  active: true,
  auditLog: [],
};
const editorUser = {
  role: "editor",
  permissions: ["read", "write"],
  createdAt: new Date(),
  active: true,
  auditLog: [],
};
const viewerUser = {
  role: "viewer",
  permissions: ["read"],
  createdAt: new Date(),
  active: true,
  auditLog: [],
};`,
    goodExample: `function createUser(role: Role, permissions: Permission[]): User {
  return { role, permissions, createdAt: new Date(), active: true, auditLog: [] };
}
const adminUser = createUser("admin", ["read", "write", "delete"]);
const editorUser = createUser("editor", ["read", "write"]);
const viewerUser = createUser("viewer", ["read"]);`,
    principle: "DRY — extract a factory when constructing similar objects",
    detectionHint:
      "3+ object literals with the same set of keys constructed in the same scope, differing only in a few values. Look for repeated property names like createdAt, active, or status across adjacent object expressions.",
  },

  {
    id: "scattered-event-handling",
    title: "Scattered event/callback registration",
    description:
      "Event listeners or callback registrations spread across a file rather than grouped in one place. Scattering makes it hard to see all behaviours attached to a source, and easy to forget cleanup.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function setup(emitter: EventEmitter) {
  loadConfig();
  emitter.on("connect", handleConnect);
  initDatabase();
  emitter.on("error", handleError);
  startHealthCheck();
  emitter.on("disconnect", handleDisconnect);
  emitter.on("message", handleMessage);
}`,
    goodExample: `function registerEventHandlers(emitter: EventEmitter) {
  emitter.on("connect", handleConnect);
  emitter.on("disconnect", handleDisconnect);
  emitter.on("error", handleError);
  emitter.on("message", handleMessage);
}

function setup(emitter: EventEmitter) {
  loadConfig();
  initDatabase();
  startHealthCheck();
  registerEventHandlers(emitter);
}`,
    principle: "SRP — centralise event wiring for discoverability and cleanup",
    detectionHint:
      "Multiple .on(), .addEventListener(), or .subscribe() calls on the same target scattered across a function body with unrelated logic between them, rather than grouped together or in a dedicated registration function.",
  },

];

const IDIOMATIC_PATTERNS: readonly AntiPattern[] = [
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

];

const SAFETY_PATTERNS: readonly AntiPattern[] = [
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
      "In an interface or type alias body, field declarations mixing both '| null' and '?' (optional) or '| undefined' for absence. Only flag actual property signature lines (name: type), never comments, TSDoc, or documentation lines.",
  },

];

const PERF_PATTERNS: readonly AntiPattern[] = [
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

/**
 * Canonical registry of all TS/React anti-patterns known to the reviewer.
 *
 * @remarks
 * Consumed by {@link buildSystemPrompt} to inject a detection reference table
 * into the LLM system prompt. The array is frozen at module level — treat it
 * as immutable.
 */
export const ANTI_PATTERNS: readonly AntiPattern[] = [
  ...CLEAN_PATTERNS,
  ...IDIOMATIC_PATTERNS,
  ...SAFETY_PATTERNS,
  ...PERF_PATTERNS,
];
