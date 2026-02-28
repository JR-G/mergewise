import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER = "ts-react/no-excessive-optional-chaining";

/**
 * Stateless rule that flags deeply chained optional access (`?.`).
 *
 * @remarks
 * Chains of three or more optional accesses signal that the data model
 * is poorly typed or that the code is defensively programming around
 * nullable values instead of narrowing them up front.
 */
export const excessiveOptionalChainingRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER,
    name: "Excessive optional chaining",
    category: "idiomatic",
    languages: ["typescript", "tsx"],
    description: "Detects deeply chained optional access (3+ levels) suggesting poor nullability modelling.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!node.parent) return false; // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- parent may be undefined at AST root
        if (isOptionalChainNode(node.parent)) return false;
        return countOptionalChainDepth(node) >= 3;
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        findings.push(
          buildFinding(context, {
            ruleId: EXCESSIVE_OPTIONAL_CHAIN_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Deeply chained optional access (`?.?.?.`) suggests the types allow too many nullable intermediate values. Narrow nullability earlier with a guard or redesign the data model so intermediate objects are non-optional.",
            confidence: 0.82,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};

function isOptionalChainNode(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken) return true;
  if (ts.isElementAccessExpression(node) && node.questionDotToken) return true;
  if (ts.isCallExpression(node) && node.questionDotToken) return true;
  return false;
}

function countOptionalChainDepth(node: ts.Node): number {
  let depth = 0;
  let current: ts.Node = node;

  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current) ||
    ts.isCallExpression(current)
  ) {
    if (current.questionDotToken) depth += 1;
    current = current.expression;
  }

  return depth;
}
