import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";

const GO_FILE_PATTERN = /\.go$/i;
const GO_FMT_PRINT_PATTERN = /\bfmt\.(?:Print|Printf|Println)\s*\(/;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

/**
 * Stateless pilot rule that flags direct `fmt.Print*` calls in added Go lines.
 *
 * @remarks
 * This rule is intentionally deterministic and diff-only so it can execute
 * through the shared pipeline without requiring repository indexing.
 */
export const goFmtPrintRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: "go/no-fmt-print",
    name: "Avoid fmt.Print in committed code",
    category: "clean",
    languages: ["go"],
    description: "Detects fmt.Print, fmt.Printf, and fmt.Println calls in added Go lines.",
  },
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedGoLines(context)) {
      if (!GO_FMT_PRINT_PATTERN.test(addedLine.evidence)) {
        continue;
      }

      findings.push(buildGoPrintFinding(context, addedLine));
    }

    return findings;
  },
};

/**
 * Deterministic pilot Go rulepack for shared pipeline execution.
 */
export const goPilotRules: readonly StatelessRule[] = [goFmtPrintRule];

type AddedGoLine = {
  filePath: string;
  line: number;
  evidence: string;
};

function buildGoPrintFinding(
  context: AnalysisContext,
  addedLine: AddedGoLine,
): Finding {
  return {
    findingId: `${goFmtPrintRule.metadata.ruleId}:${addedLine.filePath}:${addedLine.line}`,
    installationId: context.pullRequest.installationId,
    repo: context.pullRequest.repo,
    prNumber: context.pullRequest.prNumber,
    language: "go",
    ruleId: goFmtPrintRule.metadata.ruleId,
    category: "clean",
    filePath: addedLine.filePath,
    line: addedLine.line,
    evidence: addedLine.evidence,
    recommendation:
      "Avoid committing fmt.Print* calls. Remove the statement or use structured logging for diagnostics that must remain in production code.",
    confidence: 0.94,
    status: "posted",
  };
}

function* collectAddedGoLines(context: AnalysisContext): IterableIterator<AddedGoLine> {
  for (const fileDiff of context.diffs) {
    if (!GO_FILE_PATTERN.test(fileDiff.filePath)) {
      continue;
    }

    for (const hunk of fileDiff.hunks) {
      const startLine = parseHunkStartLine(hunk.header);
      if (startLine === null) {
        continue;
      }

      let lineNumber = startLine;
      for (const hunkLine of hunk.lines) {
        if (hunkLine.startsWith("+") && !hunkLine.startsWith("+++")) {
          yield {
            filePath: fileDiff.filePath,
            line: lineNumber,
            evidence: hunkLine.slice(1),
          };
          lineNumber += 1;
          continue;
        }

        if (hunkLine.startsWith(" ")) {
          lineNumber += 1;
        }
      }
    }
  }
}

function parseHunkStartLine(header: string): number | null {
  const headerMatch = HUNK_HEADER_PATTERN.exec(header);
  if (!headerMatch) {
    return null;
  }

  const startLineCapture = headerMatch[1];
  if (!startLineCapture) {
    return null;
  }

  const parsedLine = Number.parseInt(startLineCapture, 10);
  if (Number.isNaN(parsedLine)) {
    return null;
  }

  return parsedLine;
}
