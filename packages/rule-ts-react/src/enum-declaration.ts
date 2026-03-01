import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const ENUM_DECLARATION_RULE_IDENTIFIER = "ts-react/no-enum";

/**
 * Stateless rule that flags `enum` declarations in favour of `as const` objects.
 *
 * @remarks
 * TypeScript enums produce runtime code, have surprising structural typing
 * behaviour, and cannot be tree-shaken. The modern idiomatic alternative
 * is a plain object with `as const` and a derived union type.
 */
export const enumDeclarationRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: ENUM_DECLARATION_RULE_IDENTIFIER,
    name: "Enum declaration",
    category: "idiomatic",
    languages: ["typescript", "tsx"],
    description: "Detects enum declarations where as-const objects are preferred.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) =>
        ts.isEnumDeclaration(node),
      );

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: ENUM_DECLARATION_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Prefer `as const` objects over enums. Enums produce runtime code, have surprising nominal typing behaviour, and prevent tree-shaking. Use `const Status = { Active: 'active', Inactive: 'inactive' } as const` with `type Status = typeof Status[keyof typeof Status]` instead.",
            confidence: 0.88,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};
