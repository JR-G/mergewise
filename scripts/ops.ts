#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument } from "yaml";

interface StartCommandOptions {
  taskIdentifier: string;
  branchName: string;
  ownerName: string;
  scopeName: string;
}

const scriptPath = process.argv[1];
if (!scriptPath) {
  fail("unable to resolve script path");
}

const repositoryRoot = resolve(dirname(scriptPath), "..");
const runtimeDirectoryPath = resolve(repositoryRoot, ".mergewise-runtime");
const runtimeOpsDirectoryPath = resolve(runtimeDirectoryPath, "ops");
const boardFilePath = resolve(runtimeOpsDirectoryPath, "board.md");
const tasksDirectoryPath = resolve(runtimeOpsDirectoryPath, "tasks");
const taskTemplatePath = resolve(repositoryRoot, "ops/tasks/TEMPLATE.md");
const ownershipFilePath = resolve(repositoryRoot, "ops/ownership.yml");
const worktreeRootPath = process.env.WORKTREE_ROOT ?? resolve(repositoryRoot, "../mergewise-worktrees");

interface OwnershipEntry {
  ownerName: string;
  scopeName: string;
}

interface TaskBoardEntry {
  taskIdentifier: string;
  branchName: string;
  ownerName: string;
  scopeName: string;
}

interface PullRequestReference {
  number: number;
  url: string;
}

/**
 * Exits the process with a formatted error message.
 *
 * @param message - Message shown to the user.
 */
function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * Returns a safe string representation for unknown error values.
 *
 * @param caughtError - Unknown error value caught by try/catch.
 * @returns Normalized error message.
 */
function formatError(caughtError: unknown): string {
  if (caughtError instanceof Error) {
    return caughtError.message;
  }

  return String(caughtError);
}

/**
 * Prints CLI usage examples.
 */
function usage(): void {
  console.log(`Usage:
  bun run ops:start -- <task-id> <branch-name> <owner> <scope>
  bun run ops:start-session -- <session-id> <task-id> [owner] [scope] [branch-kind]
  bun run ops:agent -- <session-id> <task-id> [owner] [scope] [branch-kind]
  bun run ops:prompt -- <task-id>
  bun run ops:review-ready -- <task-id>
  bun run ops:open-pr -- <task-id>

Examples:
  bun run ops:start -- github-client feat/agent-github-client alice packages/github-client
  bun run ops:start-session -- s01 github-client
  bun run ops:agent -- s01 github-client
  bun run ops:start-session -- s01 github-client agent-1 packages/github-client fix
  bun run ops:prompt -- github-client
  bun run ops:review-ready -- github-client
  bun run ops:open-pr -- github-client`);
}

/**
 * Validates a branch-name segment for session and task identifiers.
 *
 * @param value - Candidate identifier value.
 * @param name - Human-readable field name.
 */
function validateSegment(value: string, name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    fail(`${name} must match ^[a-z0-9][a-z0-9-]*$`);
  }
}

/**
 * Returns true when a value is a supported branch kind.
 *
 * @param value - Candidate value.
 * @returns Whether the value is `feat` or `fix`.
 */
function isBranchKind(value: string): boolean {
  return value === "feat" || value === "fix";
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Candidate unknown value.
 * @returns Type guard for plain objects.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Loads ownership entries from `ops/ownership.yml`.
 *
 * @returns Ownership mapping entries.
 */
function loadOwnershipEntries(): OwnershipEntry[] {
  if (!existsSync(ownershipFilePath)) {
    return [];
  }

  try {
    const ownershipFileBody = readFileSync(ownershipFilePath, "utf8");
    const ownershipDocument = parseDocument(ownershipFileBody);
    if (ownershipDocument.errors.length > 0) {
      fail(`loadOwnershipEntries failed: invalid YAML in ${ownershipFilePath}`);
    }

    const parsedOwnership = ownershipDocument.toJSON();
    if (!isPlainObject(parsedOwnership)) {
      return [];
    }

    const ownersValue = parsedOwnership.owners;
    if (!isPlainObject(ownersValue)) {
      return [];
    }

    const ownershipEntries: OwnershipEntry[] = [];
    for (const [scopeName, ownerValue] of Object.entries(ownersValue)) {
      if (typeof ownerValue !== "string" || !ownerValue.trim()) {
        continue;
      }

      ownershipEntries.push({
        ownerName: ownerValue,
        scopeName,
      });
    }

    return ownershipEntries;
  } catch (caughtError) {
    fail(`loadOwnershipEntries failed: ${formatError(caughtError)}`);
  }
}

/**
 * Infers the most relevant scope path for a task identifier.
 *
 * @param taskIdentifier - Task identifier.
 * @param ownershipEntries - Ownership entries loaded from YAML.
 * @returns Inferred scope path.
 */
function inferScopeName(
  taskIdentifier: string,
  ownershipEntries: readonly OwnershipEntry[],
): string {
  const directPackageScope = `packages/${taskIdentifier}`;
  const directAppScope = `apps/${taskIdentifier}`;

  for (const ownershipEntry of ownershipEntries) {
    if (ownershipEntry.scopeName === directPackageScope) {
      return ownershipEntry.scopeName;
    }
  }

  for (const ownershipEntry of ownershipEntries) {
    if (ownershipEntry.scopeName === directAppScope) {
      return ownershipEntry.scopeName;
    }
  }

  for (const ownershipEntry of ownershipEntries) {
    if (ownershipEntry.scopeName.endsWith(`/${taskIdentifier}`)) {
      return ownershipEntry.scopeName;
    }
  }

  for (const ownershipEntry of ownershipEntries) {
    if (ownershipEntry.scopeName.includes(taskIdentifier)) {
      return ownershipEntry.scopeName;
    }
  }

  return directPackageScope;
}

/**
 * Resolves session-start defaults for owner and scope from CLI args and ownership map.
 *
 * @param taskIdentifier - Task identifier used for inference.
 * @param optionalArguments - Optional positional args after task identifier.
 * @returns Resolved owner, scope, and branch kind.
 */
function resolveSessionStartOptions(
  taskIdentifier: string,
  optionalArguments: readonly string[],
): { ownerName: string; scopeName: string; branchKind: string } {
  const lastArgument = optionalArguments.at(-1);
  const lastArgumentIsBranchKind = lastArgument !== undefined && isBranchKind(lastArgument);

  const branchKind = lastArgumentIsBranchKind ? lastArgument : "feat";
  const positionalArgumentsWithoutBranchKind = lastArgumentIsBranchKind
    ? optionalArguments.slice(0, -1)
    : optionalArguments;

  if (positionalArgumentsWithoutBranchKind.length > 2) {
    fail("ops:start-session accepts at most two optional positional args: [owner] [scope]");
  }

  const ownershipEntries = loadOwnershipEntries();
  const inferredScopeName = inferScopeName(taskIdentifier, ownershipEntries);
  const ownershipEntryForScope = ownershipEntries.find((ownershipEntry) =>
    ownershipEntry.scopeName === inferredScopeName
  );
  const inferredOwnerName = ownershipEntryForScope?.ownerName ?? "agent-unassigned";

  const ownerName = positionalArgumentsWithoutBranchKind[0] ?? inferredOwnerName;
  const scopeName = positionalArgumentsWithoutBranchKind[1] ?? inferredScopeName;

  return { ownerName, scopeName, branchKind };
}

/**
 * Builds a conventional branch name from session and task identifiers.
 *
 * @param sessionIdentifier - Session identifier, for example `s01`.
 * @param taskIdentifier - Task identifier, for example `github-client`.
 * @param branchKind - Branch prefix kind, either feat or fix.
 * @returns Conventional branch name.
 */
function buildSessionBranchName(
  sessionIdentifier: string,
  taskIdentifier: string,
  branchKind: string,
): string {
  validateSegment(sessionIdentifier, "session-id");
  validateSegment(taskIdentifier, "task-id");
  if (branchKind !== "feat" && branchKind !== "fix") {
    fail("branch-kind must be feat or fix");
  }

  return `${branchKind}/${sessionIdentifier}-${taskIdentifier}`;
}

/**
 * Ensures a task file exists for the provided task options.
 *
 * @param options - Inputs used to resolve and create the task file.
 * @returns Absolute path to the task file.
 */
function ensureTaskFile(options: StartCommandOptions): string {
  try {
    if (!existsSync(taskTemplatePath)) {
      fail(`ensureTaskFile(${options.taskIdentifier}, ${options.branchName}): missing template at ${taskTemplatePath}`);
    }

    mkdirSync(runtimeOpsDirectoryPath, { recursive: true });
    mkdirSync(tasksDirectoryPath, { recursive: true });
    const taskFilePath = resolve(tasksDirectoryPath, `${options.taskIdentifier}.md`);

    if (!existsSync(taskFilePath)) {
      const templateBody = readFileSync(taskTemplatePath, "utf8");
      const preparedBody = templateBody
        .replace("<task-id>", options.taskIdentifier)
        .replace(
          "`feat/<area>-<short-description>` or `fix/<area>-<short-description>`",
          `\`${options.branchName}\``,
        );
      writeFileSync(taskFilePath, preparedBody, "utf8");
    }

    return taskFilePath;
  } catch (caughtError) {
    fail(
      `ensureTaskFile(${options.taskIdentifier}, ${options.branchName}) failed: ${formatError(caughtError)}`,
    );
  }
}

/**
 * Ensures the board file exists with default table structure.
 */
function ensureBoardFile(): void {
  try {
    if (existsSync(boardFilePath)) {
      return;
    }

    mkdirSync(runtimeOpsDirectoryPath, { recursive: true });
    const defaultBoard =
      "# Agent Board\n\n" +
      "## Todo\n\n" +
      "| Task ID | Branch | Owner | Scope |\n" +
      "| --- | --- | --- | --- |\n\n" +
      "## In Progress\n\n" +
      "| Task ID | Branch | Owner | Scope |\n" +
      "| --- | --- | --- | --- |\n\n" +
      "## Done\n\n" +
      "| Task ID | Branch | Owner | Scope |\n" +
      "| --- | --- | --- | --- |\n";
    writeFileSync(boardFilePath, defaultBoard, "utf8");
  } catch (caughtError) {
    fail(`ensureBoardFile failed: ${formatError(caughtError)}`);
  }
}

/**
 * Adds the task row to the `In Progress` table when missing.
 *
 * @param options - Task metadata used to render board row.
 */
function addBoardRowToInProgress(options: StartCommandOptions): void {
  try {
    ensureBoardFile();

    const boardContents = readFileSync(boardFilePath, "utf8");
    const rowText = `| ${options.taskIdentifier} | ${options.branchName} | ${options.ownerName} | ${options.scopeName} |`;

    if (boardContents.includes(rowText)) {
      return;
    }

    const inProgressSectionPattern =
      /(## In Progress\n\n\| Task ID \| Branch \| Owner \| Scope \|\n\| --- \| --- \| --- \| --- \|\n)/;
    if (!inProgressSectionPattern.test(boardContents)) {
      fail(
        `addBoardRowToInProgress(${options.taskIdentifier}) failed: missing In Progress table header`,
      );
    }

    const updatedBoardContents = boardContents.replace(
      inProgressSectionPattern,
      `$1${rowText}\n`,
    );

    writeFileSync(boardFilePath, updatedBoardContents, "utf8");
  } catch (caughtError) {
    fail(
      `addBoardRowToInProgress(${options.taskIdentifier}) failed: ${formatError(caughtError)}`,
    );
  }
}

/**
 * Creates a new worktree for the provided branch.
 *
 * @param branchName - Branch name used to create the worktree.
 */
function createWorktree(branchName: string): void {
  try {
    execFileSync(
      "bash",
      [resolve(repositoryRoot, "scripts/worktree.sh"), "new", branchName],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
      },
    );
  } catch (caughtError) {
    fail(`createWorktree(${branchName}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Resolves the absolute worktree path for a branch.
 *
 * @param branchName - Branch name used for worktree location.
 * @returns Absolute path to the branch worktree.
 */
function resolveWorktreePath(branchName: string): string {
  return resolve(worktreeRootPath, branchName);
}

/**
 * Opens an interactive shell in the branch worktree.
 *
 * @param branchName - Branch name whose worktree should be opened.
 */
function openShellInWorktree(branchName: string): void {
  const worktreePath = resolveWorktreePath(branchName);
  if (!existsSync(worktreePath)) {
    fail(`openShellInWorktree(${branchName}) failed: missing path ${worktreePath}`);
  }

  const shellPath = process.env.SHELL ?? "zsh";
  const shellLaunchCommand = `cd ${JSON.stringify(worktreePath)} && exec ${JSON.stringify(shellPath)} -l`;

  try {
    execFileSync(shellPath, ["-lc", shellLaunchCommand], { stdio: "inherit" });
  } catch (caughtError) {
    fail(`openShellInWorktree(${branchName}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Resolves and validates a task file path by task identifier.
 *
 * @param taskIdentifier - Unique task identifier.
 * @returns Absolute path to the task file.
 */
function loadTaskFile(taskIdentifier: string): string {
  try {
    const taskFilePath = resolve(tasksDirectoryPath, `${taskIdentifier}.md`);
    if (!existsSync(taskFilePath)) {
      fail(`loadTaskFile(${taskIdentifier}) failed: task file not found at ${taskFilePath}`);
    }

    return taskFilePath;
  } catch (caughtError) {
    fail(`loadTaskFile(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Returns the final path segment for a slash-delimited path.
 *
 * @param pathValue - Slash-delimited path.
 * @returns Last segment.
 */
function getLastPathSegment(pathValue: string): string {
  const pathSegments = pathValue.split("/").filter((segment) => segment.length > 0);
  const lastPathSegment = pathSegments[pathSegments.length - 1];
  if (!lastPathSegment) {
    return pathValue;
  }

  return lastPathSegment;
}

/**
 * Parses task rows from the local runtime board.
 *
 * @returns Parsed task rows.
 */
function loadTaskBoardEntries(): TaskBoardEntry[] {
  ensureBoardFile();
  const boardContents = readFileSync(boardFilePath, "utf8");
  const tableLinePattern = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/;
  const boardEntries: TaskBoardEntry[] = [];

  for (const boardLine of boardContents.split("\n")) {
    const parsedLine = boardLine.match(tableLinePattern);
    if (!parsedLine) {
      continue;
    }

    const taskIdentifier = (parsedLine[1] ?? "").trim();
    const branchName = (parsedLine[2] ?? "").trim();
    const ownerName = (parsedLine[3] ?? "").trim();
    const scopeName = (parsedLine[4] ?? "").trim();
    if (taskIdentifier === "Task ID" || taskIdentifier === "---") {
      continue;
    }

    if (!taskIdentifier || !branchName || !scopeName) {
      continue;
    }

    boardEntries.push({
      taskIdentifier,
      branchName,
      ownerName,
      scopeName,
    });
  }

  return boardEntries;
}

/**
 * Resolves one task row from the local runtime board.
 *
 * @param taskIdentifier - Unique task identifier.
 * @returns Task row details.
 */
function resolveTaskBoardEntry(taskIdentifier: string): TaskBoardEntry {
  try {
    const matchedEntries = loadTaskBoardEntries().filter((boardEntry) =>
      boardEntry.taskIdentifier === taskIdentifier
    );

    if (matchedEntries.length === 0) {
      fail(
        `resolveTaskBoardEntry(${taskIdentifier}) failed: no board row found in ${boardFilePath}`,
      );
    }

    if (matchedEntries.length > 1) {
      const matchedBranchNames = matchedEntries.map((boardEntry) => boardEntry.branchName);
      fail(
        `resolveTaskBoardEntry(${taskIdentifier}) failed: multiple board rows found (${matchedBranchNames.join(", ")})`,
      );
    }

    const [resolvedBoardEntry] = matchedEntries;
    if (!resolvedBoardEntry) {
      fail(`resolveTaskBoardEntry(${taskIdentifier}) failed: unresolved board entry`);
    }

    return resolvedBoardEntry;
  } catch (caughtError) {
    fail(`resolveTaskBoardEntry(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Returns changed file paths between `main` and the provided branch.
 *
 * @param branchName - Branch name to compare.
 * @returns Relative changed file paths.
 */
function listChangedPathsAgainstMain(branchName: string): string[] {
  try {
    const diffOutput = execFileSync(
      "git",
      ["diff", "--name-only", `main...${branchName}`],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    return diffOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (caughtError) {
    fail(`listChangedPathsAgainstMain(${branchName}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Validates branch naming alignment with task identifier.
 *
 * @param boardEntry - Task row details.
 */
function assertTaskBranchAlignment(boardEntry: TaskBoardEntry): void {
  const normalizedBranchName = boardEntry.branchName.toLowerCase();
  const normalizedTaskIdentifier = boardEntry.taskIdentifier.toLowerCase();
  if (!normalizedBranchName.includes(normalizedTaskIdentifier)) {
    fail(
      `task-branch mismatch: task=${boardEntry.taskIdentifier} is mapped to branch=${boardEntry.branchName}`,
    );
  }
}

/**
 * Checks whether a changed path is inside the scoped path boundary.
 *
 * @param changedPath - Changed file path.
 * @param scopeName - Scoped root path from the board row.
 * @returns Whether the path is inside scope.
 */
function isPathWithinScope(changedPath: string, scopeName: string): boolean {
  return changedPath === scopeName || changedPath.startsWith(`${scopeName}/`);
}

/**
 * Validates that all changed files stay inside the task scope.
 *
 * @param boardEntry - Task row details.
 * @param changedPaths - Changed file paths.
 */
function assertScopeBoundaries(
  boardEntry: TaskBoardEntry,
  changedPaths: readonly string[],
): void {
  if (changedPaths.length === 0) {
    fail(
      `scope check failed for ${boardEntry.taskIdentifier}: no changed files found on ${boardEntry.branchName}`,
    );
  }

  const outOfScopePaths = changedPaths.filter((changedPath) =>
    !isPathWithinScope(changedPath, boardEntry.scopeName)
  );
  if (outOfScopePaths.length > 0) {
    fail(
      `scope check failed for ${boardEntry.taskIdentifier}: changed files outside scope ${boardEntry.scopeName}: ${outOfScopePaths.join(", ")}`,
    );
  }
}

/**
 * Executes mandatory quality gates inside the task branch worktree.
 *
 * @param boardEntry - Task row details.
 */
function runQualityGates(boardEntry: TaskBoardEntry): void {
  const worktreePath = resolveWorktreePath(boardEntry.branchName);
  if (!existsSync(worktreePath)) {
    fail(`runQualityGates failed: missing worktree path ${worktreePath}`);
  }

  try {
    execFileSync("bun", ["run", "quality:gates"], { cwd: worktreePath, stdio: "inherit" });
    execFileSync("bun", ["run", "lint"], { cwd: worktreePath, stdio: "inherit" });
    execFileSync("bun", ["run", "typecheck"], { cwd: worktreePath, stdio: "inherit" });
    execFileSync("bun", ["run", "test"], { cwd: worktreePath, stdio: "inherit" });
    execFileSync("bun", ["run", "build"], { cwd: worktreePath, stdio: "inherit" });
  } catch (caughtError) {
    fail(
      `runQualityGates(${boardEntry.taskIdentifier}) failed in ${worktreePath}: ${formatError(caughtError)}`,
    );
  }
}

/**
 * Runs required readiness checks before a task may open a pull request.
 *
 * @param taskIdentifier - Unique task identifier.
 */
function reviewTaskReadiness(taskIdentifier: string): void {
  loadTaskFile(taskIdentifier);
  const boardEntry = resolveTaskBoardEntry(taskIdentifier);
  assertTaskBranchAlignment(boardEntry);

  const changedPaths = listChangedPathsAgainstMain(boardEntry.branchName);
  assertScopeBoundaries(boardEntry, changedPaths);
  runQualityGates(boardEntry);

  console.log(
    `review-ready passed for task=${boardEntry.taskIdentifier} branch=${boardEntry.branchName} scope=${boardEntry.scopeName}`,
  );
}

/**
 * Prints a preformatted agent prompt for a task file.
 *
 * @param taskIdentifier - Unique task identifier.
 */
function printPrompt(taskIdentifier: string): void {
  try {
    const taskFilePath = loadTaskFile(taskIdentifier);
    const taskBody = readFileSync(taskFilePath, "utf8").trimEnd();

    console.log("Agent Prompt");
    console.log("------------");
    console.log("You are assigned one scoped task in mergewise.");
    console.log("Follow the task contract exactly.");
    console.log("");
    console.log(taskBody);
    console.log("");
    console.log("Execution rules:");
    console.log("- Only edit allowed paths from the task file.");
    console.log(
      "- Run: bun run quality:gates && bun run lint && bun run typecheck && bun run test && bun run build",
    );
    console.log("- Use TSDoc for documentation behavior notes.");
    console.log("- No inline comments.");
    console.log("- No single-letter or abbreviated variable names.");
    console.log("- Task is complete only after: quality gates pass, branch is pushed, and PR URL is posted.");
    console.log("- Open PR with: bun run ops:open-pr -- <task-id>");
    console.log("- Return PR URL in your completion message. Do not merge.");
  } catch (caughtError) {
    fail(`printPrompt(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Builds a repository pull request title from task metadata.
 *
 * @param boardEntry - Task row details.
 * @returns Conventional pull request title.
 */
function buildPullRequestTitle(boardEntry: TaskBoardEntry): string {
  const scopeLabel = getLastPathSegment(boardEntry.scopeName);
  return `task(${scopeLabel}): ${boardEntry.taskIdentifier}`;
}

/**
 * Builds a compliant pull request body with required checked quality-gate boxes.
 *
 * @param boardEntry - Task row details.
 * @param changedPaths - Changed file paths for the task branch.
 * @returns Pull request markdown body.
 */
function buildPullRequestBody(
  boardEntry: TaskBoardEntry,
  changedPaths: readonly string[],
): string {
  const changedPathList = changedPaths
    .map((changedPath) => `- \`${changedPath}\``)
    .join("\n");

  return `## Summary

- deliver task \`${boardEntry.taskIdentifier}\` in scope \`${boardEntry.scopeName}\`
- keep changes isolated to assigned path boundary
- update relevant behavior and tests for this task

### Changed Paths

${changedPathList}

## Checks

- [x] \`bun run quality:gates\`
- [x] \`bun run lint\`
- [x] \`bun run typecheck\`
- [x] \`bun run test\`
- [x] \`bun run build\`

## Quality Gate

- [x] I handled failure modes for new I/O or network boundaries.
- [x] I avoided unbounded in-memory growth in long-running paths.
- [x] I used workspace package imports for cross-package dependencies.
- [x] I avoided deep relative cross-package imports in tests and runtime code.
- [x] I avoided secret-like fixture values (for example private key block markers).
- [x] I ensured async timer callbacks handle promise rejections explicitly.
- [x] I added/updated TSDoc for exported APIs or behavior changes.
- [x] I updated user-facing docs where relevant.
`;
}

/**
 * Resolves pull request details for a branch head when one exists.
 *
 * @param branchName - Branch name used as head reference.
 * @returns Pull request details, or null when not found.
 */
function findPullRequestByHead(branchName: string): PullRequestReference | null {
  try {
    const rawResult = execFileSync(
      "gh",
      ["pr", "view", "--head", branchName, "--json", "number,url"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    const parsedResult = JSON.parse(rawResult) as Partial<PullRequestReference>;
    if (
      typeof parsedResult.number === "number" &&
      typeof parsedResult.url === "string"
    ) {
      return {
        number: parsedResult.number,
        url: parsedResult.url,
      };
    }

    return null;
  } catch (caughtError) {
    const errorText = formatError(caughtError);
    if (errorText.includes("no pull requests found")) {
      return null;
    }

    throw new Error(
      `findPullRequestByHead(${branchName}) failed in ${repositoryRoot}: ${errorText}`,
    );
  }
}

/**
 * Opens a pull request for a task branch using the GitHub CLI.
 *
 * @param taskIdentifier - Unique task identifier.
 */
function openPullRequestForTask(taskIdentifier: string): void {
  reviewTaskReadiness(taskIdentifier);
  const boardEntry = resolveTaskBoardEntry(taskIdentifier);
  const branchName = boardEntry.branchName;
  const changedPaths = listChangedPathsAgainstMain(branchName);
  const pullRequestTitle = buildPullRequestTitle(boardEntry);
  const pullRequestBody = buildPullRequestBody(boardEntry, changedPaths);
  const pullRequestBodyFilePath = resolve(
    runtimeOpsDirectoryPath,
    `pr-body-${taskIdentifier}.md`,
  );
  const existingPullRequest = findPullRequestByHead(branchName);

  try {
    writeFileSync(pullRequestBodyFilePath, pullRequestBody, "utf8");

    if (existingPullRequest) {
      execFileSync(
        "gh",
        [
          "pr",
          "edit",
          String(existingPullRequest.number),
          "--title",
          pullRequestTitle,
          "--body-file",
          pullRequestBodyFilePath,
        ],
        {
          cwd: repositoryRoot,
          stdio: "inherit",
        },
      );
      console.log(`updated pull request: ${existingPullRequest.url}`);
      return;
    }

    execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branchName,
        "--title",
        pullRequestTitle,
        "--body-file",
        pullRequestBodyFilePath,
      ],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
      },
    );
  } catch (caughtError) {
    fail(`openPullRequestForTask(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Starts one task by preparing task file, board state, and worktree.
 *
 * @param argumentsList - Positional CLI args passed after `start`.
 */
function startTask(argumentsList: string[]): void {
  const [taskIdentifier, branchName, ownerName, scopeName] = argumentsList;
  if (!taskIdentifier || !branchName || !ownerName || !scopeName) {
    usage();
    fail("missing required arguments for ops:start");
  }

  const options: StartCommandOptions = {
    taskIdentifier,
    branchName,
    ownerName,
    scopeName,
  };

  const taskFilePath = ensureTaskFile(options);
  addBoardRowToInProgress(options);
  createWorktree(options.branchName);

  console.log("\nTask started.");
  console.log(`Task file: ${taskFilePath}`);
  console.log(`Branch: ${options.branchName}`);
  console.log(`Owner: ${options.ownerName}`);
  console.log(`Scope: ${options.scopeName}`);
  console.log("\nNext:");
  console.log(`1) Fill in task details in ${taskFilePath}`);
  console.log(`2) Run: bun run ops:prompt -- ${options.taskIdentifier}`);
  console.log("3) Paste prompt to assigned agent");
}

/**
 * Starts one task with session-based branch naming.
 *
 * @param argumentsList - Positional CLI args passed after `start-session`.
 */
function startSessionTask(argumentsList: string[]): void {
  const [sessionIdentifier, taskIdentifier, ...optionalArguments] = argumentsList;
  if (!sessionIdentifier || !taskIdentifier) {
    usage();
    fail("missing required arguments for ops:start-session");
  }

  const { ownerName, scopeName, branchKind } = resolveSessionStartOptions(
    taskIdentifier,
    optionalArguments,
  );
  const branchName = buildSessionBranchName(
    sessionIdentifier,
    taskIdentifier,
    branchKind,
  );

  startTask([taskIdentifier, branchName, ownerName, scopeName]);
}

/**
 * Starts one session task, prints the prompt, and opens a shell in the task worktree.
 *
 * @param argumentsList - Positional CLI args passed after `agent`.
 */
function startAgentSession(argumentsList: string[]): void {
  const [sessionIdentifier, taskIdentifier, ...optionalArguments] = argumentsList;
  if (!sessionIdentifier || !taskIdentifier) {
    usage();
    fail("missing required arguments for ops:agent");
  }

  const { ownerName, scopeName, branchKind } = resolveSessionStartOptions(
    taskIdentifier,
    optionalArguments,
  );
  const branchName = buildSessionBranchName(
    sessionIdentifier,
    taskIdentifier,
    branchKind,
  );

  startTask([taskIdentifier, branchName, ownerName, scopeName]);
  printPrompt(taskIdentifier);
  openShellInWorktree(branchName);
}

/**
 * Entrypoint for the ops CLI subcommands.
 */
function main(): void {
  const [, , commandName, ...argumentsList] = process.argv;

  if (!commandName) {
    usage();
    process.exit(1);
  }

  if (commandName === "start") {
    startTask(argumentsList);
    return;
  }

  if (commandName === "prompt") {
    const [taskIdentifier] = argumentsList;
    if (!taskIdentifier) {
      usage();
      fail("missing task-id for ops:prompt");
    }

    try {
      printPrompt(taskIdentifier);
    } catch (caughtError) {
      fail(`prompt command failed for ${taskIdentifier}: ${formatError(caughtError)}`);
    }
    return;
  }

  if (commandName === "start-session") {
    startSessionTask(argumentsList);
    return;
  }

  if (commandName === "agent") {
    startAgentSession(argumentsList);
    return;
  }

  if (commandName === "open-pr") {
    const [taskIdentifier] = argumentsList;
    if (!taskIdentifier) {
      usage();
      fail("missing task-id for ops:open-pr");
    }

    openPullRequestForTask(taskIdentifier);
    return;
  }

  if (commandName === "review-ready") {
    const [taskIdentifier] = argumentsList;
    if (!taskIdentifier) {
      usage();
      fail("missing task-id for ops:review-ready");
    }

    reviewTaskReadiness(taskIdentifier);
    return;
  }

  usage();
  fail(`unknown command: ${commandName}`);
}

main();
