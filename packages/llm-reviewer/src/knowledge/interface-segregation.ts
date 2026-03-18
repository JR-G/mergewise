import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting Interface Segregation and Liskov Substitution violations.
 *
 * @remarks
 * Draws from the Interface Segregation Principle and Liskov Substitution Principle
 * (Robert C. Martin, SOLID), and Martin Fowler's guidance on role interfaces
 * versus header interfaces.
 */
export const INTERFACE_SEGREGATION_KNOWLEDGE: KnowledgeDocument = {
  id: "interface-segregation",
  title: "Interface Segregation and Liskov Substitution",
  category: "clean",
  triggerSignals: ["has_classes", "has_type_assertions"],
  triggerClassifications: [
    "interface-change",
    "type-safety",
    "fat-interface",
    "lsp-violation",
  ],
  fileExtensions: [],
  content: `A fat interface forces implementors to depend on methods they do not use. When a consumer only needs read access but the interface also declares write and export methods, the implementor must either provide real implementations it has no business owning or throw "not supported" — which violates the Liskov Substitution Principle.

Detection criteria — Interface Segregation:
- An interface with eight or more members where no single consumer uses all of them
- Implementors that stub multiple methods with empty bodies, no-op returns, or "not implemented" throws
- A single interface passed to functions that only call a small subset of its methods (two or three out of ten)
- Type assertions used to narrow a fat interface to the subset a consumer actually needs

Detection criteria — Liskov Substitution:
- A subtype or interface implementor that throws "not supported", "not implemented", or returns sentinel error values for inherited methods
- A class that overrides a base method to silently ignore it (empty body) when the base contract implies meaningful behaviour
- Conditional logic in callers that checks the concrete type before calling a method — a sign that the base type contract is not trustworthy

The concrete cost:
- Every new method added to the fat interface forces changes in all implementors, even those that have no use for the new capability
- Callers cannot trust the base type contract — they must check documentation or test at runtime to know which methods actually work
- Stubbed or throwing methods are invisible at compile time, leading to runtime errors that the type system should have prevented
- Testing requires constructing the full interface even when the test only exercises one capability

Solutions:
- Split the fat interface into focused role interfaces (e.g. Reader, Writer, Exporter) where each describes a single capability
- Use TypeScript intersection types to compose role interfaces for consumers that genuinely need multiple capabilities: Reader & Writer
- Prefer composition over inheritance — inject only the role interface a class needs rather than extending a base that demands everything
- For classes, implement only the role interfaces that match the class's actual capabilities

When NOT to flag:
- Interfaces where all members are genuinely needed by all consumers — the breadth reflects real requirements, not accidental growth
- Small interfaces with fewer than six members — splitting them adds indirection without meaningful benefit
- Abstract base classes with template methods where subclasses are expected to override specific hooks — this is intentional framework design`,
  examples: [
    {
      label: "Fat DocumentService interface split into Reader, Writer, and Exporter",
      scenario:
        "A DocumentService interface has ten methods covering reading, writing, and exporting. Most consumers only need read access, but they receive the full interface and must trust that the methods they do not call are safe to ignore.",
      bad: `interface DocumentService {
  getById(id: string): Promise<Document>;
  search(query: string): Promise<Document[]>;
  listRecent(limit: number): Promise<Document[]>;
  create(doc: CreateDocumentInput): Promise<Document>;
  update(id: string, changes: Partial<Document>): Promise<Document>;
  delete(id: string): Promise<void>;
  bulkDelete(ids: string[]): Promise<void>;
  exportToPdf(id: string): Promise<Buffer>;
  exportToCsv(ids: string[]): Promise<Buffer>;
  getExportHistory(id: string): Promise<ExportRecord[]>;
}`,
      good: `interface DocumentReader {
  getById(id: string): Promise<Document>;
  search(query: string): Promise<Document[]>;
  listRecent(limit: number): Promise<Document[]>;
}

interface DocumentWriter {
  create(doc: CreateDocumentInput): Promise<Document>;
  update(id: string, changes: Partial<Document>): Promise<Document>;
  delete(id: string): Promise<void>;
  bulkDelete(ids: string[]): Promise<void>;
}

interface DocumentExporter {
  exportToPdf(id: string): Promise<Buffer>;
  exportToCsv(ids: string[]): Promise<Buffer>;
  getExportHistory(id: string): Promise<ExportRecord[]>;
}

type FullDocumentService = DocumentReader & DocumentWriter & DocumentExporter;`,
      explanation:
        "A search endpoint injects DocumentReader only — it cannot accidentally call delete. A background export job injects DocumentExporter. The full intersection type is available for the rare consumer that genuinely needs everything.",
    },
    {
      label: "ReadOnlyRepo throwing on save/delete split into Readable and Writable",
      scenario:
        "A Repository interface declares both read and write methods. A ReadOnlyRepo implements it for cached lookups but throws on save and delete — callers holding a Repository reference cannot trust the contract.",
      bad: `interface Repository<T> {
  findById(id: string): Promise<T | undefined>;
  findAll(): Promise<T[]>;
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

class ReadOnlyRepo<T> implements Repository<T> {
  async findById(id: string): Promise<T | undefined> {
    return this.cache.get(id);
  }

  async findAll(): Promise<T[]> {
    return [...this.cache.values()];
  }

  async save(_entity: T): Promise<void> {
    throw new Error("Not supported: read-only repository");
  }

  async delete(_id: string): Promise<void> {
    throw new Error("Not supported: read-only repository");
  }
}`,
      good: `interface ReadableRepository<T> {
  findById(id: string): Promise<T | undefined>;
  findAll(): Promise<T[]>;
}

interface WritableRepository<T> {
  save(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
}

type Repository<T> = ReadableRepository<T> & WritableRepository<T>;

class CachedLookup<T> implements ReadableRepository<T> {
  async findById(id: string): Promise<T | undefined> {
    return this.cache.get(id);
  }

  async findAll(): Promise<T[]> {
    return [...this.cache.values()];
  }
}`,
      explanation:
        "CachedLookup only implements ReadableRepository — there are no methods to stub or throw on. Functions that only need reads accept ReadableRepository, making it impossible to accidentally pass a write-capable repository where a read-only one is expected.",
    },
  ],
};
