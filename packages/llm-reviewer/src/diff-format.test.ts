import { describe, expect, test } from "bun:test";
import { formatNumberedDiff } from "./diff-format";
import type { DiffHunk } from "@mergewise/shared-types";

function makeHunk(overrides: Partial<DiffHunk> = {}): DiffHunk {
  return {
    header: "@@ -0,0 +1,4 @@",
    lines: [
      "+const a = 1;",
      "+const b = 2;",
      "+const c = 3;",
      "+const d = 4;",
    ],
    ...overrides,
  };
}

describe("formatNumberedDiff", () => {
  test("adds line numbers to added lines", () => {
    const result = formatNumberedDiff([makeHunk()]);
    expect(result).toContain("+   1 const a = 1;");
    expect(result).toContain("+   2 const b = 2;");
    expect(result).toContain("+   4 const d = 4;");
  });

  test("preserves removed lines without numbers", () => {
    const hunk = makeHunk({
      header: "@@ -1,2 +1,2 @@",
      lines: ["-old line", "+new line"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("-old line");
    expect(result).toContain("+   1 new line");
  });

  test("numbers context lines correctly", () => {
    const hunk = makeHunk({
      header: "@@ -1,3 +1,3 @@",
      lines: [" unchanged", "+added", " also unchanged"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("    1 unchanged");
    expect(result).toContain("+   2 added");
    expect(result).toContain("    3 also unchanged");
  });

  test("starts from correct line when header offset is non-zero", () => {
    const hunk = makeHunk({
      header: "@@ -10,3 +20,3 @@",
      lines: ["+first", "+second", "+third"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("+  20 first");
    expect(result).toContain("+  21 second");
    expect(result).toContain("+  22 third");
  });

  test("handles multiple hunks with separate numbering", () => {
    const hunks: DiffHunk[] = [
      { header: "@@ -0,0 +1,2 @@", lines: ["+line one", "+line two"] },
      { header: "@@ -5,1 +10,2 @@", lines: ["+line ten", "+line eleven"] },
    ];
    const result = formatNumberedDiff(hunks);
    expect(result).toContain("+   1 line one");
    expect(result).toContain("+   2 line two");
    expect(result).toContain("+  10 line ten");
    expect(result).toContain("+  11 line eleven");
  });

  test("handles removed lines interleaved with added lines", () => {
    const hunk = makeHunk({
      header: "@@ -1,4 +1,3 @@",
      lines: [" keep", "-removed", "+replaced", " after"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("    1 keep");
    expect(result).toContain("-removed");
    expect(result).toContain("+   2 replaced");
    expect(result).toContain("    3 after");
  });

  test("preserves no-newline-at-end-of-file markers", () => {
    const hunk = makeHunk({
      header: "@@ -0,0 +1,1 @@",
      lines: ["+only line", "\\ No newline at end of file"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("\\ No newline at end of file");
  });

  test("defaults to line 1 when header is malformed", () => {
    const hunk = makeHunk({
      header: "@@ broken @@",
      lines: ["+line"],
    });
    const result = formatNumberedDiff([hunk]);
    expect(result).toContain("+   1 line");
  });

  test("returns empty string for empty hunks array", () => {
    expect(formatNumberedDiff([])).toBe("");
  });
});
