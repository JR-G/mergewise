import type { Finding } from "@mergewise/shared-types";
import type { EvalScore, ExpectedFinding } from "./types";

/**
 * Tests whether a finding matches a single expectation.
 *
 * @remarks
 * All specified match fields are AND-ed. String comparisons are
 * case-insensitive contains checks. Line matching uses an inclusive range.
 */
export function matchFinding(
  finding: Finding,
  expectation: ExpectedFinding,
): boolean {
  if (
    expectation.matchLineRange &&
    (finding.line < expectation.matchLineRange[0] ||
      finding.line > expectation.matchLineRange[1])
  ) {
    return false;
  }

  if (
    expectation.matchCategory &&
    finding.category !== expectation.matchCategory
  ) {
    return false;
  }

  if (
    expectation.matchEvidenceContains &&
    !finding.evidence
      .toLowerCase()
      .includes(expectation.matchEvidenceContains.toLowerCase())
  ) {
    return false;
  }

  if (
    expectation.matchRecommendationContains &&
    !finding.recommendation
      .toLowerCase()
      .includes(expectation.matchRecommendationContains.toLowerCase())
  ) {
    return false;
  }

  if (
    expectation.matchRecommendationContainsAny &&
    expectation.matchRecommendationContainsAny.length > 0 &&
    !expectation.matchRecommendationContainsAny.some((keyword) =>
      finding.recommendation.toLowerCase().includes(keyword.toLowerCase()),
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Scores a set of findings against expectations.
 *
 * @param findings - Findings produced by the LLM.
 * @param expectations - Expected findings for the fixture.
 * @returns Scored result with recall, precision, and unmatched findings.
 */
export function scoreFindings(
  findings: readonly Finding[],
  expectations: readonly ExpectedFinding[],
): EvalScore {
  const forbiddenExpectations = expectations.filter(
    (expectation) => expectation.forbidden === true,
  );
  const requiredExpectations = expectations.filter(
    (expectation) => expectation.required && !expectation.forbidden,
  );
  const optionalExpectations = expectations.filter(
    (expectation) => !expectation.required && !expectation.forbidden,
  );

  const matchedFindingIndices = new Set<number>();
  const falsePositiveIndices = new Set<number>();

  for (const expectation of forbiddenExpectations) {
    for (const [index, finding] of findings.entries()) {
      if (!falsePositiveIndices.has(index) && matchFinding(finding, expectation)) {
        falsePositiveIndices.add(index);
      }
    }
  }

  let requiredMatched = 0;

  for (const expectation of requiredExpectations) {
    const matchIndex = findings.findIndex(
      (finding, index) =>
        !matchedFindingIndices.has(index) &&
        !falsePositiveIndices.has(index) &&
        matchFinding(finding, expectation),
    );

    if (matchIndex !== -1) {
      matchedFindingIndices.add(matchIndex);
      requiredMatched += 1;
    }
  }

  for (const expectation of optionalExpectations) {
    const matchIndex = findings.findIndex(
      (finding, index) =>
        !matchedFindingIndices.has(index) &&
        !falsePositiveIndices.has(index) &&
        matchFinding(finding, expectation),
    );

    if (matchIndex !== -1) {
      matchedFindingIndices.add(matchIndex);
    }
  }

  const unmatchedFindings = findings.filter(
    (_, index) => !matchedFindingIndices.has(index) && !falsePositiveIndices.has(index),
  );

  const totalFindings = findings.length;
  const matchedFindings = matchedFindingIndices.size;

  return {
    requiredExpectations: requiredExpectations.length,
    requiredMatched,
    recall:
      requiredExpectations.length === 0
        ? 1.0
        : requiredMatched / requiredExpectations.length,
    totalFindings,
    matchedFindings,
    precision: totalFindings === 0 ? 1.0 : matchedFindings / totalFindings,
    unmatchedFindings,
    falsePositiveCount: falsePositiveIndices.size,
  };
}
