import type { AntiPattern } from "./anti-pattern-types";

export const CLEAN_PATTERNS: readonly AntiPattern[] = [
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
