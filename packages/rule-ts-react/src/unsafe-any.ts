import type { AnalysisContext, Finding, StatelessRule } from "@mergewise/shared-types";
import { TYPE_SCRIPT_FILE_PATTERN } from "./ast";
import {
  buildFinding,
  buildPatchPreview,
  collectAddedLines,
  NON_CODE_MARKER_PATTERN,
} from "./helpers";

const UNSAFE_ANY_RULE_IDENTIFIER = "ts-react/no-unsafe-any";

const UNSAFE_ANY_PATTERN = /(?:\bas\s+any\b|:\s*any\b|<\s*any\s*>|\bany\s*\[\s*\]|\bArray\s*<\s*any\s*>|\bReadonlyArray\s*<\s*any\s*>|\bPromise\s*<\s*any\s*>)/;

/**
 * Stateless rule that flags explicit `any` usage in changed TypeScript and React files.
 */
export const unsafeAnyUsageRule: StatelessRule = {
  kind: "stateless",
  metadata: {
    ruleId: UNSAFE_ANY_RULE_IDENTIFIER,
    name: "Unsafe any usage",
    category: "safety",
    languages: ["typescript", "tsx"],
    description: "Detects explicit any usage in added TypeScript and TSX lines.",
  },
  analyse: (context: AnalysisContext): Promise<readonly Finding[]> => {
    const findings: Finding[] = [];

    for (const addedLine of collectAddedLines(context, TYPE_SCRIPT_FILE_PATTERN)) {
      if (!UNSAFE_ANY_PATTERN.test(addedLine.sanitizedContent)) {
        continue;
      }

      const suggestedReplacement = buildManualReplacementCandidate(
        addedLine.evidence,
        addedLine.sanitizedContent,
      );
      const patchPreview =
        suggestedReplacement === null
          ? undefined
          : buildPatchPreview(addedLine.hunkHeader, addedLine.evidence, suggestedReplacement);

      findings.push(
        buildFinding(context, {
          ruleId: UNSAFE_ANY_RULE_IDENTIFIER,
          category: "safety",
          filePath: addedLine.filePath,
          line: addedLine.lineNumber,
          evidence: addedLine.evidence,
          recommendation: buildUnsafeAnyRecommendation(suggestedReplacement),
          patchPreview,
          confidence: 0.95,
        }),
      );
    }

    return Promise.resolve(findings);
  },
};

function buildManualReplacementCandidate(
  evidence: string,
  sanitizedContent: string,
): string | null {
  if (NON_CODE_MARKER_PATTERN.test(evidence) && sanitizedContent !== evidence) {
    return null;
  }

  let replacementCandidate = evidence;
  replacementCandidate = replacementCandidate.replace(/\bas\s+any\b/g, "as unknown");
  replacementCandidate = replacementCandidate.replace(/:\s*any\b/g, ": unknown");
  replacementCandidate = replacementCandidate.replace(/<\s*any\s*>/g, "<unknown>");
  replacementCandidate = replacementCandidate.replace(/\bany\s*\[\s*\]/g, "unknown[]");
  replacementCandidate = replacementCandidate.replace(/\bArray\s*<\s*any\s*>/g, "Array<unknown>");
  replacementCandidate = replacementCandidate.replace(
    /\bReadonlyArray\s*<\s*any\s*>/g,
    "ReadonlyArray<unknown>",
  );
  replacementCandidate = replacementCandidate.replace(
    /\bPromise\s*<\s*any\s*>/g,
    "Promise<unknown>",
  );

  return replacementCandidate === evidence ? null : replacementCandidate;
}

function buildUnsafeAnyRecommendation(suggestedReplacement: string | null): string {
  const baseRecommendation =
    "Explicit any is disallowed. Replace with a concrete type, unknown, or a constrained generic, then add the required narrowing. This is a manual change and no automatic patch is applied because unknown substitutions can require follow-up edits to keep compilation safe.";

  if (!suggestedReplacement) {
    return baseRecommendation;
  }

  return `${baseRecommendation} Possible manual starting point: \`${suggestedReplacement}\``;
}
