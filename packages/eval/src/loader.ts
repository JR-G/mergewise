import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff, PullRequestMetadata } from "@mergewise/shared-types";
import type { EvalFixture, ExpectedFinding } from "./types";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures");

const STUB_PR_METADATA: PullRequestMetadata = {
  repo: "eval/fixture",
  prNumber: 0,
  headSha: "0000000000000000000000000000000000000000",
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
  const sourceFile = await findSourceFile(fixtureDir);

  return {
    fixtureId: name,
    fileDiff: diffRaw,
    fullFileContent: sourceFile,
    expectations,
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

async function findSourceFile(fixtureDir: string): Promise<string | null> {
  const entries = await readdir(fixtureDir);
  const source = entries.find(
    (name) => name.endsWith(".ts") || name.endsWith(".tsx"),
  );
  if (!source) return null;
  return Bun.file(join(fixtureDir, source)).text();
}

export { STUB_PR_METADATA };
