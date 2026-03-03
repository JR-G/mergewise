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
 * Finds a maximum bipartite matching between expectations and findings
 * using Kuhn's augmenting-path algorithm.
 *
 * @param expectations - Expectations to match (left vertices).
 * @param findings - Findings to match against (right vertices).
 * @param excludedFindings - Finding indices excluded from matching (e.g. forbidden).
 * @param alreadyMatched - Finding indices already consumed by a prior pass.
 * @returns Map from expectation index to matched finding index.
 */
function maximumBipartiteMatching(
  expectations: readonly ExpectedFinding[],
  findings: readonly Finding[],
  excludedFindings: ReadonlySet<number>,
  alreadyMatched: ReadonlySet<number> = new Set(),
): Map<number, number> {
  const matchForExpectation = new Map<number, number>();
  const matchForFinding = new Map<number, number>();

  function tryAugment(
    expectationIndex: number,
    visited: Set<number>,
  ): boolean {
    for (let findingIndex = 0; findingIndex < findings.length; findingIndex++) {
      if (excludedFindings.has(findingIndex)) continue;
      if (alreadyMatched.has(findingIndex)) continue;
      if (visited.has(findingIndex)) continue;
      const finding = findings[findingIndex];
      const expectation = expectations[expectationIndex];
      if (!finding || !expectation || !matchFinding(finding, expectation)) continue;

      visited.add(findingIndex);

      const currentOwner = matchForFinding.get(findingIndex);
      if (currentOwner === undefined || tryAugment(currentOwner, visited)) {
        matchForExpectation.set(expectationIndex, findingIndex);
        matchForFinding.set(findingIndex, expectationIndex);
        return true;
      }
    }
    return false;
  }

  for (let index = 0; index < expectations.length; index++) {
    tryAugment(index, new Set());
  }

  return matchForExpectation;
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

  const requiredMatching = maximumBipartiteMatching(
    requiredExpectations,
    findings,
    falsePositiveIndices,
  );

  for (const findingIndex of requiredMatching.values()) {
    matchedFindingIndices.add(findingIndex);
  }

  const requiredMatched = requiredMatching.size;

  const optionalMatching = maximumBipartiteMatching(
    optionalExpectations,
    findings,
    falsePositiveIndices,
    matchedFindingIndices,
  );

  for (const findingIndex of optionalMatching.values()) {
    matchedFindingIndices.add(findingIndex);
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
