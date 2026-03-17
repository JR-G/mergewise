import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting hardcoded dependencies and violations of
 * the dependency inversion principle.
 *
 * @remarks
 * Draws from Robert C. Martin's SOLID principles (the D in SOLID),
 * Mark Seemann's "Dependency Injection in .NET", and general guidance
 * on testability and loose coupling.
 */
export const DEPENDENCY_INVERSION_KNOWLEDGE: KnowledgeDocument = {
  id: "dependency-inversion",
  title: "Dependency Inversion and Hardcoded Dependencies",
  category: "clean",
  triggerSignals: ["high_import_count", "has_classes"],
  triggerClassifications: [
    "hardcoded-dependency",
    "api-boundary",
    "coupling",
  ],
  fileExtensions: [],
  content: `A function or class that constructs its own concrete dependencies internally — via \`new\`, direct module calls, or inline configuration — cannot be tested in isolation and cannot have its dependencies swapped without modifying the source.

Detection criteria:
- A function body contains \`new SomeClient()\` or \`new SomeService()\` for infrastructure concerns (database clients, HTTP clients, cloud SDK clients, message queues)
- A module imports a concrete implementation and calls it directly inside business logic, rather than receiving it as a parameter
- A class constructor creates its own collaborators instead of accepting them
- Test files for the module require complex mocking of module internals (jest.mock, vi.mock of specific file paths) rather than passing in test doubles

Refactoring approaches:
- Parameter injection: accept dependencies as function parameters with a sensible default for production use
- Constructor injection: accept collaborators in the constructor and store them as private fields
- Factory functions: export a factory that wires up production dependencies, while the core function accepts abstractions
- Interface-based injection: define a slim interface for the dependency and accept anything that satisfies it

When NOT to flag:
- Module-level singletons that are intentionally shared and configured once at startup (e.g. a logger instance, a config object)
- Simple utility usage that has no side effects and needs no swapping (Math, JSON, Array methods, string manipulation)
- Internal helper functions within the same module that do not cross architectural boundaries
- Functions in the composition root or entry point whose explicit job is to wire up concrete dependencies

The concrete cost must be specific: "Testing processOrder requires a live Postgres connection because PrismaClient is constructed inside the function" or "Switching from S3 to GCS requires modifying every file that uploads, rather than changing a single factory."`,
  examples: [
    {
      label:
        "Hardcoded infrastructure clients refactored to dependency injection",
      scenario:
        "An order processing function creates its own database client and storage client internally. Every test must mock the module imports or connect to real services.",
      bad: `import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

async function processOrder(orderId: string): Promise<OrderResult> {
  const prisma = new PrismaClient();
  const s3 = new S3Client({ region: "eu-west-1" });

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
  });

  const receipt = generateReceipt(order);

  await s3.send(
    new PutObjectCommand({
      Bucket: "receipts",
      Key: \`\${orderId}.pdf\`,
      Body: receipt,
    })
  );

  await prisma.order.update({
    where: { id: orderId },
    data: { status: "completed", receiptGeneratedAt: new Date() },
  });

  return { orderId, status: "completed" };
}`,
      good: `interface OrderRepository {
  findOrder(orderId: string): Promise<Order>;
  markCompleted(orderId: string, receiptGeneratedAt: Date): Promise<void>;
}

interface ReceiptStorage {
  store(orderId: string, receipt: Buffer): Promise<void>;
}

async function processOrder(
  orderId: string,
  deps: { orders: OrderRepository; receipts: ReceiptStorage }
): Promise<OrderResult> {
  const order = await deps.orders.findOrder(orderId);
  const receipt = generateReceipt(order);
  await deps.receipts.store(orderId, receipt);
  await deps.orders.markCompleted(orderId, new Date());

  return { orderId, status: "completed" };
}`,
      explanation:
        "Tests can pass in-memory implementations of OrderRepository and ReceiptStorage with no database or AWS credentials. Switching from S3 to GCS or from Prisma to Drizzle requires writing a new adapter — the business logic never changes.",
    },
  ],
};
