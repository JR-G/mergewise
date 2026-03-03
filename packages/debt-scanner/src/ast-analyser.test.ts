import { describe, expect, test } from "bun:test";
import { analyseFile } from "./ast-analyser.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ast-analyser", () => {
  async function withFixture(
    filename: string,
    content: string,
    callback: (filePath: string, repoPath: string) => Promise<void>,
  ): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "debt-scanner-test-"));
    const filePath = join(tempDir, filename);
    await writeFile(filePath, content);
    try {
      await callback(filePath, tempDir);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  }

  test("extracts function count and line count from a TypeScript file", async () => {
    const fixture = `
function greet(name: string): string {
  return "Hello " + name;
}

function farewell(name: string): string {
  return "Goodbye " + name;
}

export function main() {
  greet("world");
  farewell("world");
}
`;
    await withFixture("example.ts", fixture, async (filePath, repoPath) => {
      const node = await analyseFile(filePath, repoPath);
      expect(node).not.toBeNull();
      expect(node!.signals.functionCount).toBeGreaterThanOrEqual(3);
      expect(node!.lineCount).toBeGreaterThan(0);
      expect(node!.kind).toBe("file");
    });
  });

  test("detects hooks in a TSX file and classifies as component", async () => {
    const fixture = `
import { useState, useEffect } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    document.title = String(count);
  }, [count]);
  return <div>{count}</div>;
}
`;
    await withFixture("Counter.tsx", fixture, async (filePath, repoPath) => {
      const node = await analyseFile(filePath, repoPath);
      expect(node).not.toBeNull();
      expect(node!.signals.hookCount).toBeGreaterThanOrEqual(2);
      expect(node!.kind).toBe("component");
    });
  });

  test("detects classes and classifies appropriately", async () => {
    const fixture = `
export class UserService {
  private users: string[] = [];

  addUser(name: string): void {
    this.users.push(name);
  }

  getUsers(): string[] {
    return this.users;
  }
}
`;
    await withFixture("service.ts", fixture, async (filePath, repoPath) => {
      const node = await analyseFile(filePath, repoPath);
      expect(node).not.toBeNull();
      expect(node!.signals.classCount).toBeGreaterThanOrEqual(1);
      expect(node!.kind).toBe("class");
    });
  });

  test("measures nesting depth for deeply nested code", async () => {
    const fixture = `
function deeply() {
  if (true) {
    for (const x of []) {
      if (x) {
        while (true) {
          break;
        }
      }
    }
  }
}
`;
    await withFixture("nested.ts", fixture, async (filePath, repoPath) => {
      const node = await analyseFile(filePath, repoPath);
      expect(node).not.toBeNull();
      expect(node!.signals.maxNestingDepth).toBeGreaterThanOrEqual(4);
    });
  });

  test("returns null for non-existent file", async () => {
    const node = await analyseFile("/nonexistent/file.ts", "/nonexistent");
    expect(node).toBeNull();
  });
});
