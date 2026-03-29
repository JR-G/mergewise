import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff, PullRequestMetadata } from "@mergewise/shared-types";
import { toRepoFullName, toPRNumber, toSHA } from "@mergewise/shared-types";
import type {
  EvalFixture,
  EvalFixtureConfig,
  ExpectedFinding,
  ReviewQualityDimension,
  ReviewQualityRubric,
} from "./types";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

const STUB_PR_METADATA: PullRequestMetadata = {
  repo: toRepoFullName("eval/fixture"),
  prNumber: toPRNumber(1),
  headSha: toSHA("0000000000000000000000000000000000000000"),
  installationId: null,
};

/**
 * Discovers fixture directories under the fixtures root.
 *
 * @param dir - Directory to scan. Defaults to the built-in fixtures directory.
 * @returns Array of fixture directory names.
 */
export async function discoverFixtures(
  dir: string = FIXTURES_DIR,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Loads a single eval fixture from disk.
 *
 * @param name - Fixture directory name.
 * @param dir - Parent directory containing fixtures. Defaults to the built-in fixtures directory.
 * @returns Parsed fixture ready for evaluation.
 */
export async function loadFixture(
  name: string,
  dir: string = FIXTURES_DIR,
): Promise<EvalFixture> {
  const fixtureDir = join(dir, name);

  let diffRaw: unknown;
  try {
    diffRaw = await Bun.file(join(fixtureDir, "diff.json")).json();
  } catch (error) {
    throw new Error(`Failed to load diff.json for fixture "${name}"`, {
      cause: error,
    });
  }

  if (!isValidFileDiff(diffRaw)) {
    throw new Error(
      `Invalid diff.json for fixture "${name}": missing filePath or hunks`,
    );
  }

  let rawExpectations: unknown;
  try {
    rawExpectations = await Bun.file(
      join(fixtureDir, "expectations.json"),
    ).json();
  } catch (error) {
    throw new Error(
      `Failed to load expectations.json for fixture "${name}"`,
      { cause: error },
    );
  }

  if (!Array.isArray(rawExpectations)) {
    throw new Error(
      `Invalid expectations.json for fixture "${name}": expected an array`,
    );
  }

  for (const [index, item] of rawExpectations.entries()) {
    if (!isValidExpectedFinding(item)) {
      throw new Error(
        `Invalid expectation at index ${index} for fixture "${name}": missing description or required`,
      );
    }
  }

  const expectations = rawExpectations as ExpectedFinding[];
  const config = await loadFixtureConfig(name, fixtureDir);
  const sourceFiles = await loadSourceFiles(fixtureDir, diffRaw.filePath);
  const sourceFile = sourceFiles.get(diffRaw.filePath) ?? null;

  return {
    fixtureId: name,
    fileDiff: diffRaw,
    fullFileContent: sourceFile,
    sourceFiles,
    expectations,
    config,
  };
}

function isValidFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["filePath"] === "string" && Array.isArray(candidate["hunks"]);
}

function isValidExpectedFinding(
  value: unknown,
): value is ExpectedFinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["description"] === "string" &&
    typeof candidate["required"] === "boolean"
  );
}

async function loadFixtureConfig(
  fixtureId: string,
  fixtureDir: string,
): Promise<EvalFixtureConfig> {
  const configPath = join(fixtureDir, "fixture.json");
  const configFile = Bun.file(configPath);
  if (!(await configFile.exists())) {
    return {};
  }

  let rawConfig: unknown;
  try {
    rawConfig = await configFile.json();
  } catch (error) {
    throw new Error(`Failed to load fixture.json for fixture "${fixtureId}"`, {
      cause: error,
    });
  }

  if (!isValidFixtureConfig(rawConfig)) {
    throw new Error(
      `Invalid fixture.json for fixture "${fixtureId}": expected object with optional executionMode, PR metadata, and reviewQuality`,
    );
  }

  return rawConfig;
}

async function loadSourceFiles(
  fixtureDir: string,
  primaryPath: string,
): Promise<ReadonlyMap<string, string>> {
  const entries = await readdir(fixtureDir);
  const sourceEntries = entries.filter((name) =>
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx"),
  );

  if (sourceEntries.length === 0) {
    return new Map();
  }

  const sourceFiles = new Map<string, string>();
  const singleSourceEntry = sourceEntries[0];

  if (sourceEntries.length === 1 && singleSourceEntry !== undefined) {
    sourceFiles.set(primaryPath, await Bun.file(join(fixtureDir, singleSourceEntry)).text());
    return sourceFiles;
  }

  for (const sourceEntry of sourceEntries) {
    sourceFiles.set(sourceEntry, await Bun.file(join(fixtureDir, sourceEntry)).text());
  }

  return sourceFiles;
}

function isValidFixtureConfig(value: unknown): value is EvalFixtureConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (
    candidate["executionMode"] !== undefined &&
    candidate["executionMode"] !== "legacy" &&
    candidate["executionMode"] !== "pipeline"
  ) {
    return false;
  }

  if (
    candidate["prTitle"] !== undefined &&
    typeof candidate["prTitle"] !== "string"
  ) {
    return false;
  }

  if (
    candidate["prDescription"] !== undefined &&
    typeof candidate["prDescription"] !== "string"
  ) {
    return false;
  }

  if (
    candidate["maxFilesPerReview"] !== undefined &&
    (
      typeof candidate["maxFilesPerReview"] !== "number" ||
      !Number.isFinite(candidate["maxFilesPerReview"]) ||
      !Number.isInteger(candidate["maxFilesPerReview"]) ||
      candidate["maxFilesPerReview"] < 1
    )
  ) {
    return false;
  }

  if (
    candidate["reviewQuality"] !== undefined &&
    !isValidReviewQualityRubric(candidate["reviewQuality"])
  ) {
    return false;
  }

  return true;
}

function isValidReviewQualityRubric(value: unknown): value is ReviewQualityRubric {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate["summary"] !== "string" ||
    typeof candidate["reviewGoal"] !== "string"
  ) {
    return false;
  }

  if (!Array.isArray(candidate["mustFind"]) || !Array.isArray(candidate["mustAvoid"])) {
    return false;
  }

  if (
    candidate["findingCountRange"] !== undefined &&
    !(
      Array.isArray(candidate["findingCountRange"]) &&
      candidate["findingCountRange"].length === 2 &&
      typeof candidate["findingCountRange"][0] === "number" &&
      typeof candidate["findingCountRange"][1] === "number" &&
      Number.isFinite(candidate["findingCountRange"][0]) &&
      Number.isFinite(candidate["findingCountRange"][1]) &&
      candidate["findingCountRange"][0] >= 0 &&
      candidate["findingCountRange"][1] >= 0 &&
      candidate["findingCountRange"][0] <= candidate["findingCountRange"][1]
    )
  ) {
    return false;
  }

  if (
    candidate["prioritise"] !== undefined &&
    !Array.isArray(candidate["prioritise"])
  ) {
    return false;
  }

  if (
    candidate["dimensions"] !== undefined &&
    !isValidReviewQualityDimensions(candidate["dimensions"])
  ) {
    return false;
  }

  return candidate["mustFind"].every(isValidExpectedFinding)
    && candidate["mustAvoid"].every(isValidExpectedFinding)
    && (candidate["prioritise"] === undefined || candidate["prioritise"].every(isValidExpectedFinding));
}

function isValidReviewQualityDimensions(
  value: unknown,
): value is readonly ReviewQualityDimension[] {
  return Array.isArray(value) && value.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate["name"] === "string"
      && typeof candidate["description"] === "string"
      && (candidate["weight"] === undefined || typeof candidate["weight"] === "number");
  });
}

export { STUB_PR_METADATA };
