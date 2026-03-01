import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const NESTED_TERNARY_RULE_IDENTIFIER = "ts-react/no-nested-ternary";

/**
 * Stateless rule that flags nested ternary expressions.
 *
 * @remarks
 * Nested ternaries reduce readability significantly. This is especially
 * problematic in JSX where they create deeply nested conditional rendering.
 */
export const nestedTernaryRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NESTED_TERNARY_RULE_IDENTIFIER,
    name: "Nested ternary expression",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects nested ternary expressions that reduce readability.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isConditionalExpression(node)) return false;
        return containsNestedConditional(node.whenTrue) ||
          containsNestedConditional(node.whenFalse);
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        const isJsx = isInsideJsxExpression(match.node);

        findings.push(
          buildFinding(context, {
            ruleId: NESTED_TERNARY_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation: isJsx
              ? "Nested ternaries in JSX create unreadable conditional rendering. Extract conditions into early returns, a lookup object, or a dedicated component that handles each branch."
              : "Nested ternary expressions are difficult to read and maintain. Use if/else statements, early returns, or a mapping object instead.",
            confidence: 0.9,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

function containsNestedConditional(node: ts.Node): boolean {
  if (ts.isConditionalExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) return containsNestedConditional(node.expression);
  return false;
}

function isInsideJsxExpression(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent as ts.Node | undefined;
  while (current) {
    if (ts.isJsxExpression(current)) return true;
    current = current.parent;
  }
  return false;
}
