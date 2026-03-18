import { describe, expect, test } from "bun:test";
import { extractStructuralSignals } from "./signals";
import { makeDiff, makeHunk } from "./test-helpers";

describe("extractStructuralSignals", () => {
  test("counts hook calls", () => {
    const diff = makeDiff("src/Component.tsx", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+const [x, setX] = useState(0)",
        "+useEffect(() => {}, [])",
        "+const ref = useRef(null)",
        "+const memo = useMemo(() => x, [x])",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.hookCount).toBe(4);
  });

  test("counts import statements", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+import React from 'react'",
        "+import { useState } from 'react'",
        "+const x = 1",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.importCount).toBe(2);
  });

  test("tracks nesting depth", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,5 @@", [
        "+function outer() {",
        "+  if (true) {",
        "+    callback(() => {",
        "+    })",
        "+  }",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxNestingDepth).toBeGreaterThanOrEqual(3);
  });

  test("counts function declarations", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+function alpha() {",
        "+}",
        "+function beta() {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.functionCount).toBe(2);
  });

  test("does not count control-flow blocks as functions", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,6 @@", [
        "+if (flag) {",
        "+  runTask()",
        "+}",
        "+for (const value of values) {",
        "+  consume(value)",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.functionCount).toBe(0);
    expect(signals.maxParameterCount).toBe(0);
  });

  test("tracks max function line count", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,8 @@", [
        "+function short() {",
        "+  return 1",
        "+}",
        "+function long() {",
        "+  const a = 1",
        "+  const b = 2",
        "+  return a + b",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxFunctionLineCount).toBeGreaterThanOrEqual(4);
  });

  test("tracks max parameter count", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+function one(a: string) {",
        "+}",
        "+function three(a: string, b: number, c: boolean) {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.maxParameterCount).toBe(3);
  });

  test("counts class declarations", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,4 @@", [
        "+class Foo {",
        "+}",
        "+class Bar {",
        "+}",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.classCount).toBe(2);
  });

  test("returns zero signals for empty diff", () => {
    const diff = makeDiff("src/empty.ts", []);

    const signals = extractStructuralSignals(diff);
    expect(signals.hookCount).toBe(0);
    expect(signals.importCount).toBe(0);
    expect(signals.functionCount).toBe(0);
    expect(signals.classCount).toBe(0);
    expect(signals.typeAssertionCount).toBe(0);
    expect(signals.maxNestingDepth).toBe(0);
    expect(signals.maxFunctionLineCount).toBe(0);
    expect(signals.maxParameterCount).toBe(0);
  });

  test("counts type assertions", () => {
    const diff = makeDiff("src/file.ts", [
      makeHunk("@@ -0,0 +1,3 @@", [
        "+const x = value as string",
        "+const y = other as number",
        "+const z = 42",
      ]),
    ]);

    const signals = extractStructuralSignals(diff);
    expect(signals.typeAssertionCount).toBe(2);
  });
});
