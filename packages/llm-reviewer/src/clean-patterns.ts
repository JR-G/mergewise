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

  {
    id: "instanceof-type-dispatch",
    title: "instanceof type dispatch",
    description:
      "An if/else chain using instanceof to dispatch different behaviour per concrete class. Adding a new type requires editing the dispatch site rather than extending via polymorphism or a handler map.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function process(payment: Payment) {
  if (payment instanceof CreditCard) {
    chargeCreditCard(payment);
  } else if (payment instanceof PayPal) {
    chargePayPal(payment);
  } else if (payment instanceof BankTransfer) {
    chargeBankTransfer(payment);
  } else if (payment instanceof Crypto) {
    chargeCrypto(payment);
  }
}`,
    goodExample: `interface Payment {
  charge(): void;
}

function process(payment: Payment) {
  payment.charge();
}`,
    principle:
      "Open/Closed — extend via polymorphism or a handler map, not instanceof chains",
    detectionHint:
      "3+ instanceof checks in an if/else chain dispatching different behaviour per class. Each branch runs distinct logic based on the concrete type.",
  },

  {
    id: "lsp-violation-incomplete-override",
    title: "LSP violation — incomplete override",
    description:
      "A subtype that throws on inherited methods instead of implementing them. Callers holding a reference to the base type cannot safely substitute the subtype, violating Liskov Substitution.",
    category: "clean",
    languages: ["typescript"],
    badExample: `class ReadOnlyCache implements DataStore {
  get(key: string) { return this.cache.get(key); }
  set(key: string, value: unknown) {
    throw new Error("Not supported: ReadOnlyCache is read-only");
  }
  delete(key: string) {
    throw new Error("Not supported");
  }
}`,
    goodExample: `interface Readable {
  get(key: string): unknown;
}
interface Writable {
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

class ReadOnlyCache implements Readable {
  get(key: string) { return this.cache.get(key); }
}`,
    principle:
      "LSP — subtypes must honour the base type contract, not throw on inherited methods",
    detectionHint:
      "Method override or interface implementation that throws Error with 'not implemented', 'not supported', or 'unsupported' instead of providing real behaviour. The subtype cannot substitute for the base.",
  },

  {
    id: "fat-interface",
    title: "Fat interface",
    description:
      "An interface with many members, most optional, forcing implementors to either stub methods they don't need or throw on unsupported operations. Splitting into focused role interfaces lets each consumer depend only on what it uses.",
    category: "clean",
    languages: ["typescript"],
    badExample: `interface DocumentService {
  create(doc: Doc): void;
  read(id: string): Doc;
  update(id: string, doc: Doc): void;
  delete(id: string): void;
  export(id: string, format: string): Buffer;
  import(data: Buffer, format: string): Doc;
  validate(doc: Doc): boolean;
  transform(doc: Doc, rules: Rule[]): Doc;
  share(id: string, user: string): void;
  revoke(id: string, user: string): void;
  history(id: string): Revision[];
  restore(id: string, rev: number): Doc;
  compress?(id: string): void;
  encrypt?(id: string, key: string): void;
}`,
    goodExample: `interface DocumentReader {
  read(id: string): Doc;
  history(id: string): Revision[];
}
interface DocumentWriter {
  create(doc: Doc): void;
  update(id: string, doc: Doc): void;
  delete(id: string): void;
}
interface DocumentExporter {
  export(id: string, format: string): Buffer;
  import(data: Buffer, format: string): Doc;
}`,
    principle: "ISP — split fat interfaces into focused role interfaces",
    detectionHint:
      "Interface with 8+ members where many are optional (?:), or a single interface consumed by multiple distinct call sites that each use a small subset of its members.",
  },

  {
    id: "hardcoded-dependency",
    title: "Hardcoded dependency",
    description:
      "A function or class that creates concrete dependencies internally with new or direct module calls, making it impossible to test in isolation or swap implementations without modifying the source.",
    category: "clean",
    languages: ["typescript"],
    badExample: `async function generateReport(reportId: string) {
  const db = new PrismaClient();
  const data = await db.report.findUnique({ where: { id: reportId } });
  const storage = new S3Client({ region: "eu-west-1" });
  await storage.send(new PutObjectCommand({ Bucket: "reports", Key: reportId, Body: data }));
  const mailer = nodemailer.createTransport({ host: "smtp.example.com" });
  await mailer.sendMail({ to: data.owner, subject: "Report ready" });
}`,
    goodExample: `async function generateReport(
  reportId: string,
  deps: { db: DatabaseClient; storage: StorageClient; mailer: MailClient }
) {
  const data = await deps.db.findReport(reportId);
  await deps.storage.upload("reports", reportId, data);
  await deps.mailer.send({ to: data.owner, subject: "Report ready" });
}`,
    principle:
      "DIP — depend on abstractions, inject concrete implementations",
    detectionHint:
      "Function or class method that creates concrete dependencies with 'new ConcreteClass()' internally, or calls specific implementations (fetch, axios, fs.*) directly instead of receiving them as constructor or function parameters.",
  },

  {
    id: "magic-literal",
    title: "Magic literal",
    description:
      "Raw numeric or string literals used directly in logic, making the code harder to read, search, and update. Named constants communicate intent and centralise change.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function calculateShipping(weight: number, zone: number): number {
  if (weight > 25) throw new Error("Too heavy");
  if (zone === 3) return weight * 4.5 + 12.99;
  if (zone === 2) return weight * 3.2 + 8.5;
  return weight * 1.8 + 5.0;
}`,
    goodExample: `const MAX_WEIGHT_KG = 25;
const SHIPPING_RATES: Record<number, { perKg: number; base: number }> = {
  3: { perKg: 4.5, base: 12.99 },
  2: { perKg: 3.2, base: 8.5 },
  1: { perKg: 1.8, base: 5.0 },
};

function calculateShipping(weight: number, zone: number): number {
  if (weight > MAX_WEIGHT_KG) throw new Error("Too heavy");
  const rate = SHIPPING_RATES[zone];
  return weight * rate.perKg + rate.base;
}`,
    principle: "Replace Magic Literal — name your constants",
    detectionHint:
      "Numeric literals (other than 0, 1, -1) or repeated string literals used in conditionals, arithmetic, or comparisons without a named constant. Look for bare numbers in if/switch conditions, multiplications, or threshold checks.",
  },

  {
    id: "long-parameter-list",
    title: "Long parameter list",
    description:
      "A function with many parameters that conceptually belong together. An options or parameter object improves readability at call sites and makes adding parameters non-breaking.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function createUser(
  name: string,
  email: string,
  age: number,
  role: string,
  department: string,
  managerId: string,
  startDate: Date,
) {
  return { name, email, age, role, department, managerId, startDate, active: true };
}`,
    goodExample: `interface CreateUserParams {
  name: string;
  email: string;
  age: number;
  role: string;
  department: string;
  managerId: string;
  startDate: Date;
}

function createUser(params: CreateUserParams) {
  return { ...params, active: true };
}`,
    principle: "Introduce Parameter Object — group related parameters",
    detectionHint:
      "Function or method with 5+ parameters. Look for long parameter lists where several parameters describe the same concept or entity and could be grouped into an object or interface.",
  },

  {
    id: "query-with-side-effect",
    title: "Query with side effect",
    description:
      "A function that both returns a value and mutates state. Callers cannot safely call it just to read data, and the side effect is hidden. Separating the query from the command makes each predictable.",
    category: "clean",
    languages: ["typescript"],
    badExample: `function getNextOrder(queue: Order[]): Order {
  const order = queue.shift()!;
  order.status = "processing";
  db.update(order);
  analytics.track("order_dequeued", order.id);
  return order;
}`,
    goodExample: `function peekNextOrder(queue: readonly Order[]): Order {
  return queue[0];
}

function dequeueOrder(queue: Order[]): Order[] {
  const [order, ...rest] = queue;
  order.status = "processing";
  db.update(order);
  analytics.track("order_dequeued", order.id);
  return rest;
}`,
    principle: "Separate Query from Modifier — a function should either read or write, not both",
    detectionHint:
      "Function that returns a value but also mutates its arguments, writes to a database, sends events, or modifies external state. The name suggests a read operation (get, find, peek, check, is, has) but the body performs writes.",
  },

  {
    id: "exposed-mutable-collection",
    title: "Exposed mutable collection",
    description:
      "A class getter or method that returns a raw reference to an internal array, Map, or Set. Callers can mutate the collection without the owner knowing, bypassing invariants and breaking encapsulation.",
    category: "clean",
    languages: ["typescript"],
    badExample: `class ShoppingCart {
  private items: CartItem[] = [];

  getItems(): CartItem[] {
    return this.items;
  }

  addItem(item: CartItem) {
    this.items.push(item);
    this.recalculateTotal();
  }
}`,
    goodExample: `class ShoppingCart {
  private items: CartItem[] = [];

  getItems(): readonly CartItem[] {
    return [...this.items];
  }

  addItem(item: CartItem) {
    this.items.push(item);
    this.recalculateTotal();
  }
}`,
    principle: "Encapsulate Collection — never expose a raw mutable reference to internal state",
    detectionHint:
      "Getter or method that returns this.someArray, this.someMap, or this.someSet directly without copying or marking as readonly. The caller receives a live reference to internal state that can be mutated externally.",
  },

];
