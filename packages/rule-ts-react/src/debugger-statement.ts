import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import ts from "typescript";
import { findAddedNodesWhere, parseChangedFiles } from "./ast";
import { buildFinding } from "./helpers";

const DEBUGGER_STATEMENT_RULE_IDENTIFIER = "ts-react/no-debugger-statement";
const ONLY_DEBUGGER_STATEMENT_PATTERN = /^\s*debugger\s*;?\s*$/;

/**
 * Stateless rule that flags debugger statements in changed TypeScript and React files.
 *
 * @remarks
 * Uses AST to find `DebuggerStatement` nodes on added lines.
 */
export const debuggerStatementRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: DEBUGGER_STATEMENT_RULE_IDENTIFIER,
    name: "Debugger statement",
    category: "clean",
    languages: ["typescript", "tsx"],
    description: "Detects debugger statements in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const parsedFile of parseChangedFiles(context)) {
      const astFindings = findAddedNodesWhere(parsedFile, (node) =>
        ts.isDebuggerStatement(node),
      );

      for (const match of astFindings) {
        const patchPreview = ONLY_DEBUGGER_STATEMENT_PATTERN.test(match.evidence)
          ? { hunkHeader: match.hunkHeader, removedLines: [match.evidence], addedLines: [] as string[] }
          : undefined;

        findings.push(
          buildFinding(context, {
            ruleId: DEBUGGER_STATEMENT_RULE_IDENTIFIER,
            category: "clean",
            filePath: parsedFile.filePath,
            line: match.lineNumber,
            evidence: match.evidence,
            recommendation:
              "Remove debugger statements before merge. Keep temporary debugging local and use logging or tests for persistent diagnostics.",
            patchPreview,
            confidence: 0.97,
          }),
        );
      }
    }

    return Promise.resolve(findings);
  },
};
