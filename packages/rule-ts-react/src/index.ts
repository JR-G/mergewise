import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";

const RULE_IDENTIFIER = "ts-react/no-unsafe-any";
const TYPE_SCRIPT_REACT_FILE_PATTERN = /\.(ts|tsx)$/i;
const HUNK_HEADER_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
const UNSAFE_ANY_PATTERN = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|\bReadonlyArray\s*<\s*any\s*>|\bPromise\s*<\s*any\s*>)/;

/**
 * Stateless rule that flags explicit `any` usage in changed TypeScript and React files.
 */
export const unsafeAnyUsageRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: RULE_IDENTIFIER,
    name: "Unsafe any usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects explicit any usage in added TypeScript and TSX lines.",
  },
  analyse: async (context: AnalysisContext): Promise<readonly Finding[]> => {
    return collectUnsafeAnyFindings(context);
  },
};

/**
 * Deterministic list of stateless TypeScript and React rules for worker consumption.
 */
export const tsReactRules: readonly StatelessRule[] = [unsafeAnyUsageRule];

function collectUnsafeAnyFindings(context: AnalysisContext): readonly Finding[] {
  const findings: Finding[] = [];

  for (const fileDiff of context.diffs) {
    if (!TYPE_SCRIPT_REACT_FILE_PATTERN.test(fileDiff.filePath)) {
      continue;
    }

    for (const hunk of fileDiff.hunks) {
      const startingLine = parseHunkStartingLine(hunk.header);
      if (startingLine === null) {
        continue;
      }

      let currentLineNumber = startingLine;
      for (const line of hunk.lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          const addedContent = line.slice(1);
          if (UNSAFE_ANY_PATTERN.test(addedContent)) {
            findings.push(
              buildFinding(
                context,
                fileDiff.filePath,
                currentLineNumber,
                addedContent,
                hunk.header,
              ),
            );
          }
          currentLineNumber += 1;
          continue;
        }

        if (line.startsWith(" ")) {
          currentLineNumber += 1;
        }
      }
    }
  }

  return findings;
}

function parseHunkStartingLine(header: string): number | null {
  const headerMatch = HUNK_HEADER_PATTERN.exec(header);
  if (!headerMatch) {
    return null;
  }

  const lineCapture = headerMatch[1];
  if (!lineCapture) {
    return null;
  }

  const parsedValue = Number.parseInt(lineCapture, 10);
  return Number.isNaN(parsedValue) ? null : parsedValue;
}

function buildFinding(
  context: AnalysisContext,
  filePath: string,
  line: number,
  evidence: string,
  hunkHeader: string,
): Finding {
  const findingIdentifier = `${RULE_IDENTIFIER}:${context.pullRequest.repo}:${context.pullRequest.prNumber}:${filePath}:${line}`;
  const suggestedReplacement = evidence.replace(/\bany\b/g, "unknown");
  return {
    findingId: findingIdentifier,
    installationId: context.pullRequest.installationId,
    repo: context.pullRequest.repo,
    prNumber: context.pullRequest.prNumber,
    language: "typescript",
    ruleId: RULE_IDENTIFIER,
    category: "safety",
    filePath,
    line,
    evidence,
    recommendation: "Replace explicit any with a concrete type, unknown, or a constrained generic to preserve type safety.",
    patchPreview: {
      removedLines: [evidence],
      addedLines: [suggestedReplacement],
      hunkHeader,
    },
    confidence: 0.95,
    status: "posted",
  };
}
