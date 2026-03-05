import { resolve } from "node:path";

const TS_FILE_PATTERN = /\.(ts|tsx)$/;
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", "__snapshots__"]);

/**
 * Collects TypeScript/TSX files from a repository, respecting `.gitignore`.
 *
 * @param repoPath - Absolute path to the repository root.
 * @returns Absolute paths of all non-ignored `.ts`/`.tsx` files.
 */
export async function collectFiles(repoPath: string): Promise<readonly string[]> {
  const absoluteRoot = resolve(repoPath);
  const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: absoluteRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`git ls-files failed with exit code ${exitCode}`);
  }

  const relativePaths = output.split("\0").filter((path) => path.length > 0);

  return relativePaths
    .filter((relativePath) => {
      if (!TS_FILE_PATTERN.test(relativePath)) return false;
      const segments = relativePath.split("/");
      return !segments.some((segment) => EXCLUDED_DIRS.has(segment));
    })
    .map((relativePath) => resolve(absoluteRoot, relativePath));
}
