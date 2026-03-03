import { describe, expect, test } from "bun:test";
import { buildGraph } from "./graph-builder.ts";
import { analyseFile } from "./ast-analyser.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("graph-builder", () => {
  test("builds edges from import declarations between files", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "debt-scanner-graph-"));

    await writeFile(
      join(tempDir, "utils.ts"),
      `export function add(left: number, right: number): number { return left + right; }\n`,
    );
    await writeFile(
      join(tempDir, "service.ts"),
      `import { add } from "./utils";\nexport function compute(): number { return add(1, 2); }\n`,
    );
    await writeFile(
      join(tempDir, "main.ts"),
      `import { compute } from "./service";\nvoid compute();\n`,
    );

    try {
      const nodes = await Promise.all([
        analyseFile(join(tempDir, "utils.ts"), tempDir),
        analyseFile(join(tempDir, "service.ts"), tempDir),
        analyseFile(join(tempDir, "main.ts"), tempDir),
      ]);

      const validNodes = nodes.filter((node) => node !== null);
      const graph = await buildGraph(validNodes, tempDir);

      expect(graph.nodes.size).toBe(3);

      const serviceImportsUtils = graph.edges.some(
        (edge) => edge.source === "service.ts" && edge.target === "utils.ts",
      );
      expect(serviceImportsUtils).toBe(true);

      const mainImportsService = graph.edges.some(
        (edge) => edge.source === "main.ts" && edge.target === "service.ts",
      );
      expect(mainImportsService).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  test("handles re-exports via export-from declarations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "debt-scanner-reexport-"));

    await writeFile(join(tempDir, "core.ts"), `export const VALUE = 42;\n`);
    await writeFile(join(tempDir, "barrel.ts"), `export { VALUE } from "./core";\n`);
    await writeFile(
      join(tempDir, "consumer.ts"),
      `import { VALUE } from "./barrel";\nvoid VALUE;\n`,
    );

    try {
      const nodes = await Promise.all([
        analyseFile(join(tempDir, "core.ts"), tempDir),
        analyseFile(join(tempDir, "barrel.ts"), tempDir),
        analyseFile(join(tempDir, "consumer.ts"), tempDir),
      ]);

      const validNodes = nodes.filter((node) => node !== null);
      const graph = await buildGraph(validNodes, tempDir);

      const barrelImportsCore = graph.edges.some(
        (edge) => edge.source === "barrel.ts" && edge.target === "core.ts",
      );
      expect(barrelImportsCore).toBe(true);

      const consumerImportsBarrel = graph.edges.some(
        (edge) => edge.source === "consumer.ts" && edge.target === "barrel.ts",
      );
      expect(consumerImportsBarrel).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  test("ignores external package imports", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "debt-scanner-external-"));

    await writeFile(
      join(tempDir, "app.ts"),
      `import express from "express";\nimport { readFile } from "node:fs/promises";\nexport const app = express();\n`,
    );

    try {
      const node = await analyseFile(join(tempDir, "app.ts"), tempDir);
      const validNodes = node ? [node] : [];
      const graph = await buildGraph(validNodes, tempDir);

      expect(graph.edges).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});
