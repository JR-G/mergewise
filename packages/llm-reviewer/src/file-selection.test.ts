import { describe, expect, test } from "bun:test";
import type { FileDiff } from "@mergewise/shared-types";
import { toFilePath } from "@mergewise/shared-types";
import { selectFilesForReview } from "./file-selection";
import { makeDiff, makeHunk } from "./test-helpers";

describe("selectFilesForReview", () => {
  test("skips test files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+line1", "+line2", "+line3", "+line4", "+line5"])]),
      makeDiff("src/app.spec.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]),
      makeDiff("__tests__/util.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+x", "+y"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips config and lockfiles", () => {
    const diffs: FileDiff[] = [
      makeDiff("eslint.config.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("tsconfig.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("package-lock.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("bun.lockb", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("skips non-TypeScript files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/styles.css", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("README.md", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/data.json", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000);
    expect(result).toHaveLength(0);
  });

  test("selects TypeScript files sorted by added line count", () => {
    const small = makeDiff("src/small.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]);
    const large = makeDiff("src/large.ts", [makeHunk("@@ -0,0 +1,5 @@", ["+a", "+b", "+c", "+d", "+e"])]);

    const result = selectFilesForReview([small, large], 100_000);
    expect(result).toHaveLength(2);
    expect(result[0]!.filePath).toBe(toFilePath("src/large.ts"));
    expect(result[1]!.filePath).toBe(toFilePath("src/small.ts"));
  });

  test("prefers tsx over ts at equal change volume", () => {
    const tsFile = makeDiff("src/util.ts", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);
    const tsxFile = makeDiff("src/Component.tsx", [makeHunk("@@ -0,0 +1,3 @@", ["+a", "+b", "+c"])]);

    const result = selectFilesForReview([tsFile, tsxFile], 100_000);
    expect(result[0]!.filePath).toBe(toFilePath("src/Component.tsx"));
  });

  test("respects token budget", () => {
    const file1 = makeDiff("src/a.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_unused, index) => `+line${index}`))]);
    const file2 = makeDiff("src/b.ts", [makeHunk("@@ -0,0 +1,10 @@", Array.from({ length: 10 }, (_unused, index) => `+line${index}`))]);

    const result = selectFilesForReview([file1, file2], 44);
    expect(result).toHaveLength(1);
  });

  test("always includes at least one file even if it exceeds budget", () => {
    const bigFile = makeDiff("src/big.ts", [makeHunk("@@ -0,0 +1,100 @@", Array.from({ length: 100 }, (_unused, index) => `+line${index}`))]);

    const result = selectFilesForReview([bigFile], 10);
    expect(result).toHaveLength(1);
  });

  test("user skip patterns exclude matching files", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/generated/types.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/app.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, ["src/generated/**"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe(toFilePath("src/app.ts"));
  });

  test("built-in skip patterns still apply alongside user patterns", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.test.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("packages/legacy/util.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
      makeDiff("src/index.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, ["packages/legacy/**"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe(toFilePath("src/index.ts"));
  });

  test("empty user skip patterns array has no effect", () => {
    const diffs: FileDiff[] = [
      makeDiff("src/app.ts", [makeHunk("@@ -0,0 +1,2 @@", ["+a", "+b"])]),
    ];

    const result = selectFilesForReview(diffs, 100_000, []);
    expect(result).toHaveLength(1);
  });
});
