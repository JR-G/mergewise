import type { Finding } from "@mergewise/shared-types";
import { ReviewClient, type ReviewClientConfig } from "@mergewise/llm-reviewer";
import type {
  EvalFixture,
  ExpectedFinding,
  ReviewQualityDimensionScore,
  ReviewQualityHeuristics,
  ReviewQualityScore,
} from "./types";
import { matchFinding } from "./scorer";

interface RawJudgeDimension {
  readonly name?: unknown;
  readonly score?: unknown;
  readonly rationale?: unknown;
}

interface RawJudgeResponse {
  readonly summary?: unknown;
  readonly dimensions?: unknown;
}

const DEFAULT_DIMENSIONS = [
  {
    name: "correctness",
    description: "Are the findings grounded in the changed code and materially correct?",
    weight: 3,
  },
  {
    name: "prioritisation",
    description: "Did the reviewer focus on the most important maintainability concerns instead of less important nits?",
    weight: 2,
  },
  {
    name: "specificity",
    description: "Are the recommendations concrete, code-specific, and explicit about engineering cost?",
    weight: 2,
  },
  {
    name: "restraint",
    description: "Did the reviewer avoid unnecessary or low-value comments and keep the number of findings appropriately tight?",
    weight: 2,
  },
] as const;
const MAX_JUDGE_FINDINGS = 20;
const MAX_JUDGE_FIELD_CHARS = 400;
const MAX_JUDGE_PROMPT_CHARS = 20_000;

function truncateForJudgeField(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 12)}…[truncated]`;
}

function countMatches(
  findings: readonly Finding[],
  expectations: readonly ExpectedFinding[],
): number {
  const matchedIndices = new Set<number>();
  let matchedCount = 0;

  for (const expectation of expectations) {
    const matchIndex = findings.findIndex((finding, index) =>
      !matchedIndices.has(index) && matchFinding(finding, expectation),
    );
    if (matchIndex === -1) continue;
    matchedIndices.add(matchIndex);
    matchedCount += 1;
  }

  return matchedCount;
}

function calculateRestraint(
  findings: readonly Finding[],
  fixture: EvalFixture,
): number {
  const rubric = fixture.config.reviewQuality;
  if (!rubric) {
    return 1;
  }

  const falsePositiveCount = countMatches(findings, rubric.mustAvoid);
  const countPenalty = (() : number => {
    if (!rubric.findingCountRange) {
      return 0;
    }

    const [minFindings, maxFindings] = rubric.findingCountRange;
    if (findings.length < minFindings) {
      return minFindings - findings.length;
    }
    if (findings.length > maxFindings) {
      return findings.length - maxFindings;
    }
    return 0;
  })();

  const rawScore = 1 - Math.min(1, falsePositiveCount * 0.5 + countPenalty * 0.25);
  return Number(rawScore.toFixed(2));
}

export function scoreReviewQualityHeuristics(
  findings: readonly Finding[],
  fixture: EvalFixture,
): ReviewQualityHeuristics | null {
  const rubric = fixture.config.reviewQuality;
  if (!rubric) {
    return null;
  }

  const mustFindCoverage = rubric.mustFind.length === 0
    ? 1
    : countMatches(findings, rubric.mustFind) / rubric.mustFind.length;
  const prioritisation = (() : number => {
    if (!rubric.prioritise || rubric.prioritise.length === 0) {
      return mustFindCoverage;
    }
    const topFindings = findings.slice(0, rubric.prioritise.length);
    return rubric.prioritise.length === 0
      ? 1
      : countMatches(topFindings, rubric.prioritise) / rubric.prioritise.length;
  })();

  return {
    mustFindCoverage: Number(mustFindCoverage.toFixed(2)),
    restraint: calculateRestraint(findings, fixture),
    prioritisation: Number(prioritisation.toFixed(2)),
  };
}

function buildJudgePrompt(
  findings: readonly Finding[],
  fixture: EvalFixture,
  heuristics: ReviewQualityHeuristics,
): string {
  const rubric = fixture.config.reviewQuality;
  if (!rubric) {
    throw new Error("Cannot build review-quality prompt without a rubric");
  }

  const dimensions = rubric.dimensions ?? DEFAULT_DIMENSIONS;
  const findingsForJudge = findings.slice(0, MAX_JUDGE_FINDINGS);
  const formattedFindings = findingsForJudge.length === 0
    ? "- No findings"
    : findingsForJudge.map((finding, index) => [
      `${index + 1}. ${finding.filePath}:${finding.line} [${finding.category}]`,
      `Evidence: ${truncateForJudgeField(finding.evidence, MAX_JUDGE_FIELD_CHARS)}`,
      `Recommendation: ${truncateForJudgeField(finding.recommendation, MAX_JUDGE_FIELD_CHARS)}`,
    ].join("\n")).join("\n\n");

  const prompt = [
    `Scenario: ${rubric.summary}`,
    `Reviewer goal: ${rubric.reviewGoal}`,
    "",
    "Required issues a strong reviewer should surface:",
    ...rubric.mustFind.map((expectation) => `- ${expectation.description}`),
    "",
    "Issues a strong reviewer should avoid surfacing:",
    ...(rubric.mustAvoid.length === 0
      ? ["- None specified"]
      : rubric.mustAvoid.map((expectation) => `- ${expectation.description}`)),
    "",
    "Heuristic pre-score:",
    `- Must-find coverage: ${heuristics.mustFindCoverage}`,
    `- Restraint: ${heuristics.restraint}`,
    `- Prioritisation: ${heuristics.prioritisation}`,
    "",
    "Judge these findings:",
    formattedFindings,
    "",
    "Score the following dimensions from 0.0 to 1.0:",
    ...dimensions.map((dimension) =>
      `- ${dimension.name}: ${dimension.description}`,
    ),
    "",
    'Respond as JSON: {"summary":"...","dimensions":[{"name":"...","score":0.0,"rationale":"..."}]}',
  ].join("\n");

  if (prompt.length <= MAX_JUDGE_PROMPT_CHARS) {
    return prompt;
  }

  throw new Error(
    `Judge prompt exceeded ${MAX_JUDGE_PROMPT_CHARS} characters after truncation`,
  );
}

function normaliseJudgeResponse(
  raw: string,
  fixture: EvalFixture,
  heuristics: ReviewQualityHeuristics,
): ReviewQualityScore {
  const dimensionDefinitions = fixture.config.reviewQuality?.dimensions ?? DEFAULT_DIMENSIONS;
  let parsed: RawJudgeResponse;
  try {
    parsed = JSON.parse(raw) as RawJudgeResponse;
  } catch {
    return {
      overall: Number(((heuristics.mustFindCoverage + heuristics.restraint + heuristics.prioritisation) / 3).toFixed(2)),
      heuristics,
      dimensions: [],
      summary: "Judge response was not valid JSON.",
      scoringMode: "heuristic",
    };
  }

  const dimensions = Array.isArray(parsed.dimensions)
    ? parsed.dimensions.flatMap((dimension): ReviewQualityDimensionScore[] => {
      const candidate = dimension as RawJudgeDimension;
      if (
        typeof candidate.name !== "string" ||
        typeof candidate.score !== "number" ||
        candidate.score < 0 ||
        candidate.score > 1 ||
        typeof candidate.rationale !== "string"
      ) {
        return [];
      }

      return [{
        name: candidate.name,
        score: Number(candidate.score.toFixed(2)),
        rationale: candidate.rationale,
      }];
    })
    : [];

  const heuristicAverage = (heuristics.mustFindCoverage + heuristics.restraint + heuristics.prioritisation) / 3;
  const dimensionWeights = new Map(
    dimensionDefinitions.map((dimension) => [dimension.name, dimension.weight ?? 1]),
  );
  const totalJudgeWeight = dimensions.reduce(
    (sum, dimension) => sum + (dimensionWeights.get(dimension.name) ?? 1),
    0,
  );
  const judgeAverage = dimensions.length === 0 || totalJudgeWeight === 0
    ? heuristicAverage
    : dimensions.reduce(
      (sum, dimension) => sum + (dimension.score * (dimensionWeights.get(dimension.name) ?? 1)),
      0,
    ) / totalJudgeWeight;

  return {
    overall: Number((((judgeAverage * 0.7) + (heuristicAverage * 0.3))).toFixed(2)),
    heuristics,
    dimensions,
    summary: typeof parsed.summary === "string" ? parsed.summary : "No judge summary provided.",
    scoringMode: dimensions.length === 0 ? "heuristic" : "judge",
  };
}

export async function scoreReviewQuality(
  findings: readonly Finding[],
  fixture: EvalFixture,
  judgeClientConfig: ReviewClientConfig | undefined,
): Promise<ReviewQualityScore | null> {
  const heuristics = scoreReviewQualityHeuristics(findings, fixture);
  if (!heuristics) {
    return null;
  }

  if (!judgeClientConfig) {
    return {
      overall: Number((((heuristics.mustFindCoverage + heuristics.restraint + heuristics.prioritisation) / 3)).toFixed(2)),
      heuristics,
      dimensions: [],
      summary: "No judge model configured; overall score is heuristic-only.",
      scoringMode: "heuristic",
    };
  }

  const client = new ReviewClient(judgeClientConfig);
  try {
    const { content } = await client.complete(
      "You are evaluating the quality of AI code review output for a refactoring-focused reviewer. Judge the reviewer, not the underlying code author.",
      buildJudgePrompt(findings, fixture, heuristics),
      2048,
      0.1,
    );

    return normaliseJudgeResponse(content, fixture, heuristics);
  } catch {
    return {
      overall: Number((((heuristics.mustFindCoverage + heuristics.restraint + heuristics.prioritisation) / 3)).toFixed(2)),
      heuristics,
      dimensions: [],
      summary: "Judge request failed; overall score is heuristic-only.",
      scoringMode: "heuristic",
    };
  }
}
