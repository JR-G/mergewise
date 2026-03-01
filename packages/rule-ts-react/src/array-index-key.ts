import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { TYPE_SCRIPT_JSX_FILE_PATTERN, findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const ARRAY_INDEX_KEY_RULE_IDENTIFIER = "ts-react/no-array-index-key";
const INDEX_VARIABLE_NAMES = new Set(["index", "idx", "i"]);

/**
 * Stateless rule that flags JSX `key` props backed by array indexes.
 *
 * @remarks
 * Uses AST to find JSX attributes named `key` whose initialiser is an identifier
 * commonly used as a map callback index parameter (`index`, `idx`, `i`).
 */
export const arrayIndexKeyRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: ARRAY_INDEX_KEY_RULE_IDENTIFIER,
    name: "Array index React key",
    category: "idiomatic",
    languages: ["tsx"],
    description: "Detects JSX key props that use array index variables.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context, TYPE_SCRIPT_JSX_FILE_PATTERN)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) => {
        if (!ts.isJsxAttribute(node)) return false;
        if (!ts.isIdentifier(node.name) || node.name.text !== "key") return false;
        if (!node.initializer || !ts.isJsxExpression(node.initializer)) return false;
        const expression = node.initializer.expression;
        if (!expression || !ts.isIdentifier(expression)) return false;
        return INDEX_VARIABLE_NAMES.has(expression.text);
      });

      for (const match of astFindings) {
        findings.push(
          buildFinding(context, {
            ruleId: ARRAY_INDEX_KEY_RULE_IDENTIFIER,
            category: "idiomatic",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Do not use array index as a React key. Use a stable identifier from the item data so reorder and insertion operations keep component state aligned.",
            confidence: 0.9,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};
