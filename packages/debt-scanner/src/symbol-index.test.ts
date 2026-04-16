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
});
