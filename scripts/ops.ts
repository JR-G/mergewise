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

Examples:
  bun run ops:start -- github-client feat/agent-github-client alice packages/github-client
  bun run ops:start-session -- s01 github-client
  bun run ops:agent -- s01 github-client
  bun run ops:start-session -- s01 github-client agent-1 packages/github-client fix
  bun run ops:prompt -- github-client`);
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
      "- Run: bun run lint && bun run typecheck && bun run test && bun run build",
    );
    console.log("- Use TSDoc for documentation behavior notes.");
    console.log("- No inline comments.");
    console.log("- No single-letter or abbreviated variable names.");
    console.log("- Commit and push branch, do not merge.");
  } catch (caughtError) {
    fail(`printPrompt(${taskIdentifier}) failed: ${formatError(caughtError)}`);
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

  usage();
  fail(`unknown command: ${commandName}`);
}

main();
