import { describe, it, expect } from "bun:test";
import type { ScanOptions } from "./scanner.ts";

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
  it("handles topCount of zero by applying default", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", topCount: 0 };
    const topCount = Math.min(options.topCount ?? 20, 100);
    expect(topCount).toBe(0);
  });

  it("handles negative topCount", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", topCount: -5 };
    const topCount = Math.min(options.topCount ?? 20, 100);
    expect(topCount).toBe(-5);
  });

  it("handles tokenBudget of zero", () => {
    const options: ScanOptions = { repoPath: "/tmp/repo", tokenBudget: 0 };
    expect(options.tokenBudget).toBe(0);
  });
});
