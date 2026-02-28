import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER = "ts-react/no-type-assertion-chain";

/**
 * Stateless rule that flags `as unknown as T` type assertion chains.
 *
 * @remarks
 * Double type assertions bypass the type system entirely. This pattern is a
 * stronger red flag than a single `as` cast because it signals intentional
 * circumvention of type safety rather than a simple widening.
 */
export const typeAssertionChainRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER,
    name: "Type assertion chain",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects double type assertions (as unknown as T) that bypass the type system.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const seen = new Set<number>();

      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isAsExpression(node)) return false;
        return ts.isAsExpression(node.expression);
      });

      for (const match of astFindings) {
        if (seen.has(match.lineNumber)) continue;
        seen.add(match.lineNumber);

        findings.push(
          buildFinding(context, {
            ruleId: TYPE_ASSERTION_CHAIN_RULE_IDENTIFIER,
            category: "safety",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Double type assertions (`as X as Y`) bypass the type system entirely. Introduce a proper type guard, generic constraint, or redesign the types so the compiler can verify the conversion without a forced cast chain.",
            confidence: 0.95,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};
