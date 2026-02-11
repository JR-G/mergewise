import { describe, expect, test } from "bun:test";

import { makeAnalysisContext, makeDiffHunk, makeFileDiff } from "./fixtures";
import { tsReactRules, unsafeAnyUsageRule } from "./index";

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
    expect(findings.every((finding) => finding.patchPreview !== undefined)).toBe(true);
    expect(findings[0]!.patchPreview).toEqual({
      removedLines: ["const payload: any = fetchData();"],
      addedLines: ["const payload: unknown = fetchData();"],
      hunkHeader: "@@ -10,1 +10,4 @@",
    });
    expect(findings[1]!.patchPreview).toEqual({
      removedLines: ["const result = payload as any;"],
      addedLines: ["const result = payload as unknown;"],
      hunkHeader: "@@ -10,1 +10,4 @@",
    });
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

  test("exposes deterministic rule list for worker integration", () => {
    expect(tsReactRules).toHaveLength(1);
    expect(tsReactRules[0]).toBe(unsafeAnyUsageRule);
    expect(tsReactRules[0]!.kind).toBe("stateless");
    expect(tsReactRules[0]!.metadata.ruleId).toBe("ts-react/no-unsafe-any");
  });
});
