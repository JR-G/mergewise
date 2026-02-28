import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { TYPE_SCRIPT_JSX_FILE_PATTERN, isOnAddedLine, parseChangedFiles } from "./ast";
import { buildFinding, buildPatchPreview } from "./helpers";

const NON_NULL_ASSERTION_RULE_IDENTIFIER = "ts-react/no-non-null-assertion";

/**
 * Stateless rule that flags non-null assertions (`!`) in changed TypeScript and React files.
 *
 * @remarks
 * Uses the TypeScript AST to identify `NonNullExpression` nodes and strips them
 * from the evidence to produce a patch preview. Definite-assignment assertions
 * on class fields are excluded.
 */
export const nonNullAssertionRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NON_NULL_ASSERTION_RULE_IDENTIFIER,
    name: "Non-null assertion usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects non-null assertions in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const visit = (node: ts.Node): void => {
        if (!ts.isNonNullExpression(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        const lineInfo = isOnAddedLine(parsedFile, node);
        if (!lineInfo || seen.has(lineInfo.lineNumber) || isDefiniteAssignmentContext(node)) {
          ts.forEachChild(node, visit);
          return;
        }

        seen.add(lineInfo.lineNumber);
        const scriptKind = TYPE_SCRIPT_JSX_FILE_PATTERN.test(parsedFile.filePath)
          ? ts.ScriptKind.TSX
          : ts.ScriptKind.TS;
        const replacementLine = buildNonNullAssertionReplacement(
          lineInfo.evidence,
          scriptKind,
        );
        const patchPreview = replacementLine
          ? buildPatchPreview(lineInfo.hunkHeader, lineInfo.evidence, replacementLine)
          : undefined;

        findings.push(
          buildFinding(context, {
            ruleId: NON_NULL_ASSERTION_RULE_IDENTIFIER,
            category: "safety",
            filePath: parsedFile.filePath,
            line: lineInfo.lineNumber,
            evidence: lineInfo.evidence,
            recommendation:
              "Avoid non-null assertions. Add an explicit null guard or narrow the value before access so runtime null cases stay safe.",
            patchPreview,
            confidence: 0.92,
          }),
        );

        ts.forEachChild(node, visit);
      };

      visit(parsedFile.sourceFile);
    }

    return Promise.resolve(findings);
  },
};

function isDefiniteAssignmentContext(node: ts.Node): boolean {
  if (!node.parent || !ts.isPropertyDeclaration(node.parent)) return false; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- parent may be undefined at AST root
  return node.parent.exclamationToken !== undefined;
}

function buildNonNullAssertionReplacement(
  evidence: string,
  scriptKind: ts.ScriptKind,
): string | null {
  const sourceFile = ts.createSourceFile(
    "added-line.ts",
    evidence,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const exclamationIndexes: number[] = [];

  const visitNode = (node: ts.Node): void => {
    if (ts.isNonNullExpression(node)) {
      exclamationIndexes.push(node.expression.end);
    }
    ts.forEachChild(node, visitNode);
  };
  visitNode(sourceFile);

  if (exclamationIndexes.length === 0) {
    return null;
  }

  let result = evidence;
  for (const exclamationIndex of [...exclamationIndexes].sort((left, right) => right - left)) {
    if (result[exclamationIndex] === "!") {
      result = result.slice(0, exclamationIndex) + result.slice(exclamationIndex + 1);
    }
  }

  return result === evidence ? null : result;
}
