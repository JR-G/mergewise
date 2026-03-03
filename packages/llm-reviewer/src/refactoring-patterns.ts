import type { AntiPattern } from "./anti-pattern-types";

export const REFACTORING_PATTERNS: readonly AntiPattern[] = [
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
      "Numeric literals (other than 0, 1, -1) or repeated string literals used inline in conditionals, arithmetic, or comparisons instead of referencing a named constant. Look for bare numbers in if/switch conditions, multiplications, or threshold checks. Do NOT flag the right-hand side of a named constant declaration (e.g. `const MAX_RETRIES = 3`) — that IS the fix, not the problem.",
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
    id: "inconsistent-absent-value",
    title: "Inconsistent absent value representation",
    description:
      "An interface or type mixes null, undefined, and optional (?) to represent the absence of a value. Inconsistent representation forces callers to handle multiple absence shapes, increasing branch complexity and bug risk.",
    category: "clean",
    languages: ["typescript"],
    badExample: `interface UserProfile {
  name: string;
  email: string | null;
  phone?: string;
  address: string | undefined;
}`,
    goodExample: `interface UserProfile {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}`,
    principle: "Consistency — pick one absent-value convention and apply it everywhere",
    detectionHint:
      "Interface or type alias where some properties use `| null`, others use `| undefined`, and others use `?:` optional syntax. The same type mixes two or more ways to represent 'no value'.",
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
