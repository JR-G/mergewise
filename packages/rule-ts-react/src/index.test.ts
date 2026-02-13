import { describe, expect, test } from "bun:test";

import { makeAnalysisContext, makeDiffHunk, makeFileDiff } from "./fixtures";
import {
  arrayIndexKeyRule,
  debuggerStatementRule,
  nonNullAssertionRule,
  tsReactRules,
  unsafeAnyUsageRule,
} from "./index";

describe("rule-ts-react unsafe any usage", () => {
  test("reports explicit any usage on added TypeScript and TSX lines", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -10,1 +10,4 @@", [
          " const value = 5;",
          "+const payload: any = fetchData();",
          "+const result = payload as any;",
          "+const numbers: Array<any> = [];",
        ]),
      ]),
      makeFileDiff("src/component.tsx", [
        makeDiffHunk("@@ -2,0 +2,2 @@", [
          "+type Props = { children: any[] };",
          "+export function View(props: Props) { return <div>{props.children.length}</div>; }",
        ]),
      ]),
    ]);

    const findings = await unsafeAnyUsageRule.analyse(context);

    expect(findings).toHaveLength(4);
    expect(findings.map((finding) => finding.filePath)).toEqual([
      "src/example.ts",
      "src/example.ts",
      "src/example.ts",
      "src/component.tsx",
    ]);
    expect(findings.map((finding) => finding.line)).toEqual([11, 12, 13, 2]);
    expect(findings.every((finding) => finding.ruleId === "ts-react/no-unsafe-any")).toBe(true);
    expect(findings.every((finding) => finding.category === "safety")).toBe(true);
    expect(findings.every((finding) => finding.status === "posted")).toBe(true);
    expect(findings.every((finding) => finding.patchPreview === undefined)).toBe(true);
    expect(findings[0]!.recommendation).toContain("manual change");
    expect(findings[0]!.recommendation).toContain("Possible manual starting point");
  });

  test("ignores non-TypeScript files and safe type usage", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,1 +1,3 @@", [
          " const previous = true;",
          "+const payload: unknown = fetchData();",
          "+const normalized = payload as Record<string, string>;",
        ]),
      ]),
      makeFileDiff("src/readme.md", [
        makeDiffHunk("@@ -1,0 +1,2 @@", [
          "+this line includes : any but file is markdown",
          "+as any appears here too",
        ]),
      ]),
    ]);

    const findings = await unsafeAnyUsageRule.analyse(context);

    expect(findings).toEqual([]);
  });

  test("ignores any-like text inside strings and comments in TypeScript files", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,0 +1,6 @@", [
          "+const label = \"as any\";",
          "+const detail = 'Array<any>';",
          "+const note = `Promise<any>`;",
          "+// any used only in comment",
          "+const value = fetchData(); /* any in trailing comment */",
          "+const nextValue = value;",
        ]),
      ]),
    ]);

    const findings = await unsafeAnyUsageRule.analyse(context);

    expect(findings).toEqual([]);
  });

  test("uses manual-only recommendation when a replacement candidate is ambiguous", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,0 +1,2 @@", [
          "+const payload: any = fetchData(\"source\");",
          "+const otherValue = payload;",
        ]),
      ]),
    ]);

    const findings = await unsafeAnyUsageRule.analyse(context);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.patchPreview).toBeUndefined();
    expect(findings[0]!.recommendation).toContain("manual change");
    expect(findings[0]!.recommendation).not.toContain("Possible manual starting point");
  });

  test("scans each file independently when block comments span file boundaries", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/first.ts", [
        makeDiffHunk("@@ -1,0 +1,1 @@", ["+const note = /* unclosed block comment"]),
      ]),
      makeFileDiff("src/second.ts", [
        makeDiffHunk("@@ -1,0 +1,1 @@", ["+const payload: any = fetchData();"]),
      ]),
    ]);

    const findings = await unsafeAnyUsageRule.analyse(context);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.filePath).toBe("src/second.ts");
    expect(findings[0]!.line).toBe(1);
  });
});

describe("rule-ts-react non-null assertion", () => {
  test("reports non-null assertions and provides patch previews", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -4,0 +4,3 @@", [
          "+const length = user!.name.length;",
          "+const node = reference!;",
          "+return node;",
        ]),
      ]),
    ]);

    const findings = await nonNullAssertionRule.analyse(context);

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.line)).toEqual([4, 5]);
    expect(findings.every((finding) => finding.ruleId === "ts-react/no-non-null-assertion")).toBe(
      true,
    );
    expect(findings[0]!.patchPreview).toEqual({
      hunkHeader: "@@ -4,0 +4,3 @@",
      removedLines: ["const length = user!.name.length;"],
      addedLines: ["const length = user.name.length;"],
    });
    expect(findings[1]!.patchPreview).toEqual({
      hunkHeader: "@@ -4,0 +4,3 @@",
      removedLines: ["const node = reference!;"],
      addedLines: ["const node = reference;"],
    });
  });

  test("guards against false positives for inequality and boolean negation", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,0 +1,4 @@", [
          "+if (value !== undefined && value != null) {",
          "+  return !isDisabled;",
          "+}",
          "+const message = \"user!.name\";",
        ]),
      ]),
    ]);

    const findings = await nonNullAssertionRule.analyse(context);

    expect(findings).toEqual([]);
  });
});

describe("rule-ts-react array index key", () => {
  test("reports jsx keys that use index variables", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/list.tsx", [
        makeDiffHunk("@@ -8,0 +8,3 @@", [
          "+{items.map((item, index) => <Row key={index} value={item.value} />)}",
          "+{values.map((value, idx) => <Cell key={idx} value={value} />)}",
          "+{entries.map((entry, i) => <Node key={i} node={entry} />)}",
        ]),
      ]),
    ]);

    const findings = await arrayIndexKeyRule.analyse(context);

    expect(findings).toHaveLength(3);
    expect(findings.every((finding) => finding.ruleId === "ts-react/no-array-index-key")).toBe(true);
    expect(findings.every((finding) => finding.category === "idiomatic")).toBe(true);
    expect(findings.every((finding) => finding.patchPreview === undefined)).toBe(true);
  });

  test("guards against stable-key and non-tsx false positives", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/list.tsx", [
        makeDiffHunk("@@ -1,0 +1,3 @@", [
          "+{items.map((item, index) => <Row key={item.id} value={item.value} />)}",
          "+{items.map((item, index) => <Row key={`${item.id}-${index}`} value={item.value} />)}",
          "+const template = \"key={index}\";",
        ]),
      ]),
      makeFileDiff("src/helper.ts", [
        makeDiffHunk("@@ -1,0 +1,1 @@", ["+const key = { index: 1 };"]),
      ]),
    ]);

    const findings = await arrayIndexKeyRule.analyse(context);

    expect(findings).toEqual([]);
  });
});

describe("rule-ts-react debugger statement", () => {
  test("reports debugger statements and patches standalone statements", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,0 +1,3 @@", [
          "+debugger;",
          "+if (shouldPause) debugger;",
          "+return value;",
        ]),
      ]),
    ]);

    const findings = await debuggerStatementRule.analyse(context);

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.line)).toEqual([1, 2]);
    expect(findings[0]!.patchPreview).toEqual({
      hunkHeader: "@@ -1,0 +1,3 @@",
      removedLines: ["debugger;"],
      addedLines: [],
    });
    expect(findings[1]!.patchPreview).toBeUndefined();
  });

  test("guards against strings, comments, and identifier names", async () => {
    const context = makeAnalysisContext([
      makeFileDiff("src/example.ts", [
        makeDiffHunk("@@ -1,0 +1,4 @@", [
          "+const message = \"debugger;\";",
          "+// debugger;",
          "+const debuggerEnabled = true;",
          "+return debuggerEnabled;",
        ]),
      ]),
    ]);

    const findings = await debuggerStatementRule.analyse(context);

    expect(findings).toEqual([]);
  });
});

describe("rule-ts-react exported rules", () => {
  test("exposes deterministic rule list for worker integration", () => {
    expect(tsReactRules).toHaveLength(4);
    expect(tsReactRules).toEqual([
      unsafeAnyUsageRule,
      nonNullAssertionRule,
      arrayIndexKeyRule,
      debuggerStatementRule,
    ]);
    expect(tsReactRules.map((rule) => rule.kind)).toEqual([
      "stateless",
      "stateless",
      "stateless",
      "stateless",
    ]);
    expect(tsReactRules.map((rule) => rule.metadata.ruleId)).toEqual([
      "ts-react/no-unsafe-any",
      "ts-react/no-non-null-assertion",
      "ts-react/no-array-index-key",
      "ts-react/no-debugger-statement",
    ]);
  });
});
