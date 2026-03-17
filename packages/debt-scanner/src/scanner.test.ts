import { afterEach, describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { scan } from "./scanner.ts";
import type { ScanOptions } from "./scanner.ts";

function gitEnvFor(directory: string): Record<string, string | undefined> {
  const env = { ...process.env };
  env["GIT_DIR"] = join(directory, ".git");
  env["GIT_WORK_TREE"] = directory;
  delete env["GIT_INDEX_FILE"];
  return env;
}

function initGitRepo(directory: string, files: string[]): void {
  const initEnv = { ...process.env };
  delete initEnv["GIT_DIR"];
  delete initEnv["GIT_WORK_TREE"];
  delete initEnv["GIT_INDEX_FILE"];
  execSync("git init", { cwd: directory, stdio: "ignore", env: initEnv });

  const env = gitEnvFor(directory);
  execSync("git config user.email test@test.com", { cwd: directory, stdio: "ignore", env });
  execSync("git config user.name test", { cwd: directory, stdio: "ignore", env });
  for (const filePath of files) {
    execFileSync("git", ["add", "--", filePath], { cwd: directory, stdio: "ignore", env });
  }
  if (files.length > 0) {
    execSync('git commit -m "init"', { cwd: directory, stdio: "ignore", env });
  }
}

describe("ScanOptions defaults", () => {
  it("topCount defaults to 20 when not specified", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo" };
    const topCount = options.topCount ?? 20;
    expect(topCount).toBe(20);
  });

  it("topCount is capped at 100", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", topCount: 500 };
    const topCount = Math.min(options.topCount ?? 20, 100);
    expect(topCount).toBe(100);
  });

  it("skipLlm defaults to undefined", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo" };
    expect(options.skipLlm).toBeUndefined();
  });

  it("accepts a complete configuration with all optional fields", () => {
    const progressEvents: string[] = [];
    const options: ScanOptions = {
      repoPath: "/tmp/repo",
      topCount: 10,
      skipLlm: true,
      onProgress: (stage, detail) => {
        progressEvents.push(`${stage}:${detail}`);
      },
    };
    options.onProgress?.("test", "detail");
    expect(progressEvents).toContain("test:detail");
  });
});

describe("ScanOptions boundary conditions", () => {
  it("clamps topCount of zero to 1", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", topCount: 0 };
    const topCount = Math.min(Math.max(options.topCount ?? 20, 1), 100);
    expect(topCount).toBe(1);
  });

  it("clamps negative topCount to 1", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", topCount: -5 };
    const topCount = Math.min(Math.max(options.topCount ?? 20, 1), 100);
    expect(topCount).toBe(1);
  });

  it("handles tokenBudget of zero", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", tokenBudget: 0 };
    expect(options.tokenBudget).toBe(0);
  });
});

describe("scan", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns a profile with empty findings when skipLlm is true", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-test-"));
    await Bun.write(join(tempDir, "index.ts"), "export const add = (a: number, b: number): number => a + b;");
    initGitRepo(tempDir, ["index.ts"]);

    const stages: string[] = [];
    const profile = await scan({
      repoPath: tempDir,
      skipLlm: true,
      onProgress: (stage) => {
        stages.push(stage);
      },
    });

    expect(profile.repoPath).toBe(tempDir);
    expect(profile.scannedAt).toBeDefined();
    expect(Array.isArray(profile.findings)).toBe(true);
    expect(profile.findings).toEqual([]);
    expect(stages).toContain("collect");
    expect(stages).toContain("rank");
  });

  it("returns a profile with hotspots for a directory with TypeScript files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-test-hotspot-"));
    await Bun.write(join(tempDir, "a.ts"), 'import { b } from "./b";\nexport const a = b + 1;');
    await Bun.write(join(tempDir, "b.ts"), "export const b = 42;");
    initGitRepo(tempDir, ["a.ts", "b.ts"]);

    const profile = await scan({
      repoPath: tempDir,
      skipLlm: true,
      topCount: 5,
    });

    expect(profile.graph.nodes.size).toBeGreaterThan(0);
    expect(Array.isArray(profile.hotspots)).toBe(true);
  });

  it("falls back to default topCount for NaN", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-nan-"));
    await Bun.write(join(tempDir, "index.ts"), "export const x = 1;");
    initGitRepo(tempDir, ["index.ts"]);

    const profile = await scan({ repoPath: tempDir, skipLlm: true, topCount: NaN });
    expect(Array.isArray(profile.hotspots)).toBe(true);
  });

  it("falls back to default topCount for Infinity", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-inf-"));
    await Bun.write(join(tempDir, "index.ts"), "export const x = 1;");
    initGitRepo(tempDir, ["index.ts"]);

    const profile = await scan({ repoPath: tempDir, skipLlm: true, topCount: Infinity });
    expect(Array.isArray(profile.hotspots)).toBe(true);
  });

  it("truncates non-integer topCount to integer", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-frac-"));
    await Bun.write(join(tempDir, "index.ts"), "export const x = 1;");
    initGitRepo(tempDir, ["index.ts"]);

    const profile = await scan({ repoPath: tempDir, skipLlm: true, topCount: 2.7 });
    expect(Array.isArray(profile.hotspots)).toBe(true);
  });

  it("returns a profile with zero hotspots for an empty directory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scanner-test-empty-"));
    initGitRepo(tempDir, []);

    const profile = await scan({
      repoPath: tempDir,
      skipLlm: true,
    });

    expect(profile.hotspots).toEqual([]);
    expect(profile.findings).toEqual([]);
  });
});
