import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexSymbols } from "./symbol-index";

describe("indexSymbols", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    tempDir = "";
  });

  test("indexes top-level exported and local symbols", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "symbol-index-"));
    const filePath = join(tempDir, "src.ts");
    await Bun.write(
      filePath,
      [
        "export interface User {",
        "  id: string;",
        "}",
        "export type UserId = string;",
        "export class UserStore {}",
        "export function loadUser(): User {",
        "  return { id: \"1\" };",
        "}",
        "export const useUser = () => loadUser();",
        "const localFlag = true;",
      ].join("\n"),
    );

    const symbols = await indexSymbols([filePath], tempDir);

    expect(symbols.some((symbol) => symbol.name === "User" && symbol.kind === "interface" && symbol.exported)).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "UserId" && symbol.kind === "type" && symbol.exported)).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "UserStore" && symbol.kind === "class" && symbol.exported)).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "loadUser" && symbol.kind === "function" && symbol.exported)).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "useUser" && symbol.kind === "constant" && symbol.exported)).toBe(true);
    expect(symbols.some((symbol) => symbol.name === "localFlag" && symbol.kind === "constant" && !symbol.exported)).toBe(true);
  });

  test("ignores destructured variable declarations", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "symbol-index-"));
    const filePath = join(tempDir, "src.ts");
    await Bun.write(
      filePath,
      [
        "const { foo } = config;",
        "const [state] = useThing();",
        "const named = 1;",
      ].join("\n"),
    );

    const symbols = await indexSymbols([filePath], tempDir);

    expect(symbols.some((symbol) => symbol.name === "foo")).toBe(false);
    expect(symbols.some((symbol) => symbol.name === "state")).toBe(false);
    expect(symbols.some((symbol) => symbol.name === "named")).toBe(true);
  });

  test("bounds symbol count per file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "symbol-index-"));
    const filePath = join(tempDir, "many.ts");
    const lines = Array.from({ length: 250 }, (_, index) => `export const symbol${index} = ${index};`);
    await Bun.write(filePath, lines.join("\n"));

    const symbols = await indexSymbols([filePath], tempDir);

    expect(symbols.length).toBe(200);
  });

  test("captures declaration snippets for indexed symbols", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "symbol-index-"));
    const filePath = join(tempDir, "src.ts");
    await Bun.write(
      filePath,
      [
        "export function loadUser(): User {",
        "  return { id: \"1\" };",
        "}",
        "export const userLabel = \"user\";",
      ].join("\n"),
    );

    const symbols = await indexSymbols([filePath], tempDir);
    const functionSymbol = symbols.find((symbol) => symbol.name === "loadUser");
    const constantSymbol = symbols.find((symbol) => symbol.name === "userLabel");

    expect(functionSymbol?.snippet).toContain("export function loadUser(): User {");
    expect(functionSymbol?.snippet).toContain("return { id: \"1\" };");
    expect(constantSymbol?.snippet).toBe("export const userLabel = \"user\";");
  });

  test("truncates oversized declaration snippets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "symbol-index-"));
    const filePath = join(tempDir, "large.ts");
    const lines = [
      "export function buildThing(): string {",
      ...Array.from({ length: 60 }, (_, index) => `  const line${index} = "${"x".repeat(120)}";`),
      "  return line0;",
      "}",
    ];
    await Bun.write(filePath, lines.join("\n"));

    const symbols = await indexSymbols([filePath], tempDir);
    const symbol = symbols.find((entry) => entry.name === "buildThing");

    expect(symbol).toBeDefined();
    expect(symbol!.snippet).toContain("... [truncated]");
    expect(symbol!.snippet.length).toBeLessThanOrEqual(4_016);
  });
});
