import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const NEGATED_CONDITION_RULE_IDENTIFIER = "ts-react/no-negated-condition";

/**
 * Stateless rule that flags `if (!condition)` with an else branch.
 *
 * @remarks
 * Negated conditions with else branches force readers to perform double
 * negation mentally. Flipping the branches improves readability.
 */
export const negatedConditionRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: NEGATED_CONDITION_RULE_IDENTIFIER,
    name: "Negated condition with else",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects negated if-conditions that have else branches, suggesting the positive path first.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isIfStatement(node)) return false;
        if (!node.elseStatement) return false;
        if (ts.isIfStatement(node.elseStatement)) return false;
        return isNegatedExpression(node.expression);
      });

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: NEGATED_CONDITION_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Avoid negated conditions when an else branch exists. Flip the condition to test the positive case first so readers avoid mental double-negation.",
            confidence: 0.85,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

function isNegatedExpression(node: ts.Expression): boolean {
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return isNegatedExpression(node.expression);
  }
  return false;
}
