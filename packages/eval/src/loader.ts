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

  const diffRaw = await Bun.file(join(fixtureDir, "diff.json")).json() as FileDiff;
  const expectations = await Bun.file(join(fixtureDir, "expectations.json")).json() as ExpectedFinding[];

  const sourceFile = await findSourceFile(fixtureDir);

  return {
    fixtureId: name,
    fileDiff: diffRaw,
    fullFileContent: sourceFile,
    expectations,
  };
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
