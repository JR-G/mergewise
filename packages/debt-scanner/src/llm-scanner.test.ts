import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HotspotEntry } from "./graph-types.ts";
import { scanWithLlm } from "./llm-scanner.ts";

function makeHotspot(overrides: Partial<HotspotEntry> = {}): HotspotEntry {
  return {
    nodeId: "file:src/index.ts",
    filePath: "src/index.ts",
    score: 0.85,
    centrality: 0.06,
    signalDensity: 0.4,
    lineCount: 200,
    ...overrides,
  };
}

describe("scanWithLlm", () => {
  let originalFetch: typeof globalThis.fetch;
  let tempDir: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    tempDir = await mkdtemp(join(tmpdir(), "llm-scanner-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns validated findings from the LLM response", async () => {
    await Bun.write(join(tempDir, "src/index.ts"), "function bigFunction() { return 1; }");

    const llmResponse = JSON.stringify({
      findings: [
        {
          line: 1,
          endLine: 1,
          category: "clean",
          confidence: 0.9,
          evidence: "Large function",
          recommendation: "Split into smaller functions",
          patternId: "god-function",
        },
      ],
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: llmResponse } }],
          usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    ) as unknown as typeof globalThis.fetch;

    const findings = await scanWithLlm(
      [makeHotspot({ filePath: "src/index.ts" })],
      tempDir,
      {
        clientConfig: { apiKey: "test-key", maxRetries: 0 },
      },
    );

    expect(findings.some((finding) => finding.category === "clean")).toBe(true);
    expect(findings.some((finding) => finding.patternId === "god-function")).toBe(true);
  });

  it("returns empty findings when the LLM response has no findings", async () => {
    await Bun.write(join(tempDir, "src/utils.ts"), "export const add = (a: number, b: number) => a + b;");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"findings": []}' } }],
          usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    ) as unknown as typeof globalThis.fetch;

    const findings = await scanWithLlm(
      [makeHotspot({ filePath: "src/utils.ts" })],
      tempDir,
      {
        clientConfig: { apiKey: "test-key", maxRetries: 0 },
      },
    );

    expect(findings).toEqual([]);
  });

  it("skips files that cannot be read and reports via onFileError", async () => {
    const errors: { filePath: string; error: unknown }[] = [];

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"findings": []}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    ) as unknown as typeof globalThis.fetch;

    const findings = await scanWithLlm(
      [makeHotspot({ filePath: "nonexistent/file.ts" })],
      tempDir,
      {
        clientConfig: { apiKey: "test-key", maxRetries: 0 },
        onFileError: (filePath, error) => {
          errors.push({ filePath, error });
        },
      },
    );

    expect(findings).toEqual([]);
    expect(errors.some((entry) => entry.filePath === "nonexistent/file.ts")).toBe(true);
  });

  it("filters out findings with invalid confidence values", async () => {
    await Bun.write(join(tempDir, "src/low-conf.ts"), "const x = 1;");

    const llmResponse = JSON.stringify({
      findings: [
        {
          line: 1,
          category: "clean",
          confidence: 0.3,
          evidence: "low confidence finding",
          recommendation: "should be filtered",
        },
      ],
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: llmResponse } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    ) as unknown as typeof globalThis.fetch;

    const findings = await scanWithLlm(
      [makeHotspot({ filePath: "src/low-conf.ts" })],
      tempDir,
      {
        clientConfig: { apiKey: "test-key", maxRetries: 0 },
      },
    );

    expect(findings).toEqual([]);
  });
});

describe("HotspotEntry structure", () => {
  it("constructs a valid hotspot with required fields", () => {
    const hotspot = makeHotspot();
    expect(hotspot.filePath).toBe("src/index.ts");
    expect(hotspot.centrality).toBeGreaterThan(0);
  });

  it("allows overriding specific fields", () => {
    const hotspot = makeHotspot({
      filePath: "src/utils.ts",
      centrality: 0.12,
      lineCount: 500,
    });
    expect(hotspot.filePath).toBe("src/utils.ts");
    expect(hotspot.lineCount).toBe(500);
  });
});
