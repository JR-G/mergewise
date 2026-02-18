#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseDocument } from "yaml";
import { extractTaskGoal, hasPlaceholderGoal } from "./task-file";

interface StartCommandOptions {
  taskIdentifier: string;
  branchName: string;
  ownerName: string;
  scopeName: string;
}

interface BacklogEntry {
  taskIdentifier: string;
  initiative: string;
  scope: string;
  status: string;
  exitCriteria: string;
}

const scriptPath = process.argv[1];
if (!scriptPath) {
  fail("unable to resolve script path");
}

const repositoryRoot = resolve(dirname(scriptPath), "..");
const gitCommonDirectoryPath = resolveGitCommonDirectory(repositoryRoot);
const sharedRepositoryRoot = dirname(gitCommonDirectoryPath);
const runtimeDirectoryPath = resolve(sharedRepositoryRoot, ".mergewise-runtime");
const runtimeOpsDirectoryPath = resolve(runtimeDirectoryPath, "ops");
const boardFilePath = resolve(runtimeOpsDirectoryPath, "board.md");
const backlogFilePath = resolve(runtimeDirectoryPath, "backlog.md");
const tasksDirectoryPath = resolve(runtimeOpsDirectoryPath, "tasks");
const taskTemplatePath = resolve(repositoryRoot, "ops/tasks/TEMPLATE.md");
const ownershipFilePath = resolve(repositoryRoot, "ops/ownership.yml");
const worktreeRootPath =
  process.env.WORKTREE_ROOT ?? resolve(sharedRepositoryRoot, "../mergewise-worktrees");

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
 * Resolves the shared `.git` common directory for the current repository.
 *
 * @param rootPath - Repository root inferred from the executing script.
 * @returns Absolute path to the git common directory.
 */
function resolveGitCommonDirectory(rootPath: string): string {
  try {
    const commonDirectoryPath = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: rootPath,
        encoding: "utf8",
      },
    ).trim();

    if (!commonDirectoryPath) {
      return resolve(rootPath, ".git");
    }

    return commonDirectoryPath;
  } catch {
    return resolve(rootPath, ".git");
  }
}

/**
 * Prints CLI usage examples.
 */
function usage(): void {
  console.log(`Usage:
  bun run ops:start -- <task-id> <branch-name> <owner> <scope>
  bun run ops:start-session -- <session-id> <task-id> [owner] [scope] [branch-kind]
  bun run ops:start-batch -- <session-id> <task-id> [task-id...]
  bun run ops:tmux-batch -- <session-id> <task-id> [task-id...]
  bun run ops:reset
  bun run ops:validate-session -- <session-id>
  bun run ops:launch-agent -- <task-id>
  bun run ops:agent -- <session-id> <task-id> [owner] [scope] [branch-kind]
  bun run ops:prompt -- <task-id>
  bun run ops:finish -- <task-id>
  bun run ops:review-ready -- <task-id>
  bun run ops:open-pr -- <task-id>

Examples:
  bun run ops:start -- github-client feat/agent-github-client alice packages/github-client
  bun run ops:start-session -- s01 github-client
  bun run ops:start-batch -- s01 mw-003 mw-004 mw-006
  bun run ops:tmux-batch -- s01 mw-003 mw-004 mw-006
  bun run ops:reset
  bun run ops:validate-session -- s01
  bun run ops:launch-agent -- mw-003
  bun run ops:agent -- s01 github-client
  bun run ops:start-session -- s01 github-client agent-1 packages/github-client fix
  bun run ops:prompt -- github-client
  bun run ops:finish -- github-client
  bun run ops:review-ready -- github-client
  bun run ops:open-pr -- github-client`);
}

/**
 * Returns true when a task identifier is managed by the local backlog contract.
 *
 * @param taskIdentifier - Candidate task identifier.
 * @returns Whether the identifier uses the `mw-###` format.
 */
function isManagedTaskIdentifier(taskIdentifier: string): boolean {
  return /^mw-\d+$/i.test(taskIdentifier.trim());
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
  const scopeContract = resolveTaskScopeContract(taskIdentifier, inferredScopeName);
  const ownershipEntryForScope = ownershipEntries.find((ownershipEntry) =>
    ownershipEntry.scopeName === scopeContract.scopeName
  );
  const inferredOwnerName = ownershipEntryForScope?.ownerName ?? "agent-unassigned";

  const ownerName = positionalArgumentsWithoutBranchKind[0] ?? inferredOwnerName;
  const scopeName = positionalArgumentsWithoutBranchKind[1] ?? scopeContract.scopeName;
  if (isManagedTaskIdentifier(taskIdentifier)) {
    const normalizedProvidedScopeName = normalizeScopeName(scopeName);
    const normalizedContractScopeName = normalizeScopeName(scopeContract.scopeName);
    if (normalizedProvidedScopeName !== normalizedContractScopeName) {
      fail(
        `scope override is not allowed for managed task ${taskIdentifier}: ` +
        `provided=${normalizedProvidedScopeName} contract=${normalizedContractScopeName}`,
      );
    }
  }

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
 * Returns a normalized task identifier for case-insensitive matching.
 *
 * @param taskIdentifier - Raw task identifier.
 * @returns Lower-cased identifier.
 */
function normalizeTaskIdentifier(taskIdentifier: string): string {
  return taskIdentifier.trim().toLowerCase();
}

/**
 * Parses backlog table rows from `.mergewise-runtime/backlog.md`.
 *
 * @returns Parsed backlog entries.
 */
function loadBacklogEntries(): BacklogEntry[] {
  if (!existsSync(backlogFilePath)) {
    return [];
  }

  try {
    const backlogContents = readFileSync(backlogFilePath, "utf8");
    const parsedEntries: BacklogEntry[] = [];
    const tableLinePattern = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/;

    for (const backlogLine of backlogContents.split("\n")) {
      const parsedLine = backlogLine.match(tableLinePattern);
      if (!parsedLine) {
        continue;
      }

      const taskIdentifier = (parsedLine[1] ?? "").trim();
      const initiative = (parsedLine[3] ?? "").trim();
      const scope = (parsedLine[4] ?? "").trim();
      const status = (parsedLine[5] ?? "").trim();
      const exitCriteria = (parsedLine[6] ?? "").trim();
      if (taskIdentifier === "ID" || taskIdentifier === "---") {
        continue;
      }

      if (!taskIdentifier || !scope || !exitCriteria) {
        continue;
      }

      parsedEntries.push({
        taskIdentifier,
        initiative,
        scope,
        status,
        exitCriteria,
      });
    }

    return parsedEntries;
  } catch (caughtError) {
    fail(`loadBacklogEntries failed: ${formatError(caughtError)}`);
  }
}

/**
 * Resolves one backlog row by task identifier.
 *
 * @param taskIdentifier - Unique task identifier.
 * @returns Matching backlog entry if present.
 */
function resolveBacklogEntry(taskIdentifier: string): BacklogEntry | null {
  const normalizedTaskIdentifier = normalizeTaskIdentifier(taskIdentifier);
  return loadBacklogEntries().find((backlogEntry) =>
    normalizeTaskIdentifier(backlogEntry.taskIdentifier) === normalizedTaskIdentifier
  ) ?? null;
}

/**
 * Resolves one backlog row and fails for managed task identifiers when missing.
 *
 * @param taskIdentifier - Unique task identifier.
 * @returns Matching backlog row or null for unmanaged tasks.
 */
function resolveRequiredBacklogEntry(taskIdentifier: string): BacklogEntry | null {
  const backlogEntry = resolveBacklogEntry(taskIdentifier);
  if (isManagedTaskIdentifier(taskIdentifier) && !backlogEntry) {
    fail(
      `missing backlog contract for ${taskIdentifier} in ${backlogFilePath}; ` +
      "add the item before starting a session task",
    );
  }

  return backlogEntry;
}

/**
 * Splits a backlog scope string into path prefixes.
 *
 * @param scopeValue - Backlog scope column value.
 * @returns Path prefixes from scope.
 */
function parseScopePaths(scopeValue: string): string[] {
  return scopeValue
    .split(",")
    .map((scopeSegment) => scopeSegment.trim().replace(/\/\.\.\.$/, "").replace(/\/$/, ""))
    .filter((scopeSegment) => scopeSegment.length > 0);
}

/**
 * Resolves concrete scope paths for one task.
 *
 * @param taskIdentifier - Unique task identifier.
 * @param fallbackScopeName - Fallback scope when no backlog contract is required.
 * @returns Scope paths and the string persisted in board/task metadata.
 */
function resolveTaskScopeContract(
  taskIdentifier: string,
  fallbackScopeName: string,
): { scopePaths: string[]; scopeName: string } {
  const backlogEntry = resolveRequiredBacklogEntry(taskIdentifier);
  if (backlogEntry) {
    const scopePaths = parseScopePaths(backlogEntry.scope);
    if (scopePaths.length === 0) {
      fail(`invalid backlog scope for ${taskIdentifier}: ${backlogEntry.scope}`);
    }

    return {
      scopePaths,
      scopeName: scopePaths.join(", "),
    };
  }

  const fallbackScopePaths = parseScopePaths(fallbackScopeName);
  if (fallbackScopePaths.length === 0) {
    fail(`missing scope contract for ${taskIdentifier}`);
  }

  return {
    scopePaths: fallbackScopePaths,
    scopeName: fallbackScopePaths.join(", "),
  };
}

/**
 * Builds task-file path bullets from scope paths.
 *
 * @param pathPrefixes - Path prefixes to render.
 * @returns Markdown bullet lines.
 */
function buildAllowedPathBullets(pathPrefixes: readonly string[]): string {
  if (pathPrefixes.length === 0) {
    return "- `packages/...`\n- `apps/...`";
  }

  return pathPrefixes.map((pathPrefix) => `- \`${pathPrefix}/...\``).join("\n");
}

/**
 * Renders goal text from task and backlog metadata.
 *
 * @param taskIdentifier - Task identifier.
 * @param backlogEntry - Optional backlog row for the task.
 * @returns Concrete delivery goal text.
 */
function buildTaskGoal(taskIdentifier: string, backlogEntry: BacklogEntry | null): string {
  if (!backlogEntry && isManagedTaskIdentifier(taskIdentifier)) {
    fail(`missing concrete goal contract for ${taskIdentifier} in ${backlogFilePath}`);
  }

  if (!backlogEntry) {
    return `Deliver task ${taskIdentifier} end-to-end within the declared scope, with tests and passing quality checks.`;
  }

  if (!backlogEntry.initiative) {
    return backlogEntry.exitCriteria;
  }

  return `${backlogEntry.initiative}. Exit criteria: ${backlogEntry.exitCriteria}`;
}

/**
 * Populates template placeholders for one task file.
 *
 * @param templateBody - Task template markdown.
 * @param options - Task metadata.
 * @param backlogEntry - Optional backlog row for this task.
 * @returns Hydrated task file body.
 */
function renderTaskFileBody(
  templateBody: string,
  options: StartCommandOptions,
  backlogEntry: BacklogEntry | null,
): string {
  const allowedPathBullets = buildAllowedPathBullets(
    parseScopePaths(backlogEntry?.scope ?? options.scopeName),
  );
  const taskGoal = buildTaskGoal(options.taskIdentifier, backlogEntry);
  const backlogStatus = backlogEntry?.status ?? "in_progress";

  return templateBody
    .replaceAll("<task-id>", options.taskIdentifier)
    .replaceAll("<branch-name>", options.branchName)
    .replaceAll("<goal>", taskGoal)
    .replaceAll("<allowed-paths>", allowedPathBullets)
    .replaceAll("<scope-prefixes>", allowedPathBullets)
    .replaceAll("<board-state>", backlogStatus)
    .replaceAll("YYYY-MM-DD", new Date().toISOString().slice(0, 10));
}

/**
 * Resolves task metadata required to hydrate a task file.
 *
 * @param taskIdentifier - Unique task identifier.
 * @returns Task options suitable for task-file rendering.
 */
function resolveTaskOptions(taskIdentifier: string): StartCommandOptions {
  const normalizedTaskIdentifier = normalizeTaskIdentifier(taskIdentifier);
  const boardEntry = loadTaskBoardEntries().find((candidateBoardEntry) =>
    normalizeTaskIdentifier(candidateBoardEntry.taskIdentifier) === normalizedTaskIdentifier
  );
  const ownershipEntries = loadOwnershipEntries();
  const inferredScopeName = boardEntry?.scopeName ?? inferScopeName(taskIdentifier, ownershipEntries);
  const scopeContract = resolveTaskScopeContract(taskIdentifier, inferredScopeName);

  return {
    taskIdentifier,
    branchName: boardEntry?.branchName ?? `feat/${taskIdentifier}`,
    ownerName: boardEntry?.ownerName ?? "agent-unassigned",
    scopeName: scopeContract.scopeName,
  };
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
    const templateBody = readFileSync(taskTemplatePath, "utf8");
    const backlogEntry = resolveBacklogEntry(options.taskIdentifier);

    if (!existsSync(taskFilePath)) {
      const preparedBody = renderTaskFileBody(templateBody, options, backlogEntry);
      writeFileSync(taskFilePath, preparedBody, "utf8");
      return taskFilePath;
    }

    const existingTaskBody = readFileSync(taskFilePath, "utf8");
    if (hasPlaceholderGoal(existingTaskBody)) {
      const preparedBody = renderTaskFileBody(templateBody, options, backlogEntry);
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

    const boardContents = removeBoardRowsForTask(
      readFileSync(boardFilePath, "utf8"),
      options.taskIdentifier,
    );
    const rowText = `| ${options.taskIdentifier} | ${options.branchName} | ${options.ownerName} | ${options.scopeName} |`;

    if (boardContents.includes(rowText)) {
      writeFileSync(boardFilePath, boardContents, "utf8");
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
 * Removes all board rows for a specific task identifier.
 *
 * @param boardContents - Current board markdown body.
 * @param taskIdentifier - Task identifier to remove.
 * @returns Board markdown body without matching task rows.
 */
function removeBoardRowsForTask(boardContents: string, taskIdentifier: string): string {
  const tableLinePattern = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/;
  const filteredLines: string[] = [];

  for (const boardLine of boardContents.split("\n")) {
    const parsedLine = boardLine.match(tableLinePattern);
    if (!parsedLine) {
      filteredLines.push(boardLine);
      continue;
    }

    const parsedTaskIdentifier = (parsedLine[1] ?? "").trim();
    if (parsedTaskIdentifier === taskIdentifier) {
      continue;
    }

    filteredLines.push(boardLine);
  }

  return filteredLines.join("\n");
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
    const taskOptions = resolveTaskOptions(taskIdentifier);
    const taskFilePath = resolve(tasksDirectoryPath, `${taskIdentifier}.md`);
    if (!existsSync(taskFilePath)) {
      ensureTaskFile(taskOptions);
    } else {
      const existingTaskBody = readFileSync(taskFilePath, "utf8");
      if (hasPlaceholderGoal(existingTaskBody)) {
        ensureTaskFile(taskOptions);
      }
    }

    if (!existsSync(taskFilePath)) {
      fail(
        `loadTaskFile(${taskIdentifier}) failed: task file not found after hydration at ${taskFilePath}`,
      );
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
  try {
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
  } catch (caughtError) {
    fail(`loadTaskBoardEntries failed to read board file ${boardFilePath}: ${formatError(caughtError)}`);
  }
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
 * Normalizes a comma-separated scope string for deterministic comparisons.
 *
 * @param scopeName - Scope value from board or backlog.
 * @returns Normalized scope string.
 */
function normalizeScopeName(scopeName: string): string {
  return parseScopePaths(scopeName).join(", ");
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
 * Returns true when a branch has at least one commit ahead of main.
 *
 * @param branchName - Branch name to compare.
 * @returns Whether the branch is ahead of main.
 */
function hasCommitsAheadOfMain(branchName: string): boolean {
  try {
    const revisionCountOutput = execFileSync(
      "git",
      ["rev-list", "--count", `main..${branchName}`],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    ).trim();

    const revisionCount = Number.parseInt(revisionCountOutput, 10);
    return Number.isFinite(revisionCount) && revisionCount > 0;
  } catch (caughtError) {
    fail(`hasCommitsAheadOfMain(${branchName}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Fails when a task branch has zero commits ahead of main.
 *
 * @param boardEntry - Task row details.
 */
function assertBranchHasCommittedChanges(boardEntry: TaskBoardEntry): void {
  if (!hasCommitsAheadOfMain(boardEntry.branchName)) {
    fail(
      `review-ready failed for ${boardEntry.taskIdentifier}: branch ${boardEntry.branchName} has no commits ahead of main`,
    );
  }
}

/**
 * Fails when the task worktree has uncommitted changes.
 *
 * @param boardEntry - Task row details.
 */
function assertWorktreeClean(boardEntry: TaskBoardEntry): void {
  const worktreePath = resolveWorktreePath(boardEntry.branchName);
  if (!existsSync(worktreePath)) {
    fail(`assertWorktreeClean failed: missing worktree path ${worktreePath}`);
  }

  try {
    const porcelainStatus = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();

    if (porcelainStatus.length > 0) {
      fail(
        `review-ready failed for ${boardEntry.taskIdentifier}: uncommitted changes exist in ${worktreePath}`,
      );
    }
  } catch (caughtError) {
    fail(`assertWorktreeClean(${boardEntry.taskIdentifier}) failed: ${formatError(caughtError)}`);
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

  const allowedScopePaths = parseScopePaths(boardEntry.scopeName);
  if (allowedScopePaths.length === 0) {
    fail(`scope check failed for ${boardEntry.taskIdentifier}: empty scope contract`);
  }

  const outOfScopePaths = changedPaths.filter((changedPath) => {
    return !allowedScopePaths.some((scopePath) => isPathWithinScope(changedPath, scopePath));
  });
  if (outOfScopePaths.length > 0) {
    fail(
      `scope check failed for ${boardEntry.taskIdentifier}: changed files outside scope ${boardEntry.scopeName}: ${outOfScopePaths.join(", ")}`,
    );
  }
}

/**
 * Validates that managed tasks are scoped to backlog-defined path prefixes.
 *
 * @param boardEntry - Task row details.
 */
function assertManagedTaskScopeContract(boardEntry: TaskBoardEntry): void {
  if (!isManagedTaskIdentifier(boardEntry.taskIdentifier)) {
    return;
  }

  const backlogEntry = resolveRequiredBacklogEntry(boardEntry.taskIdentifier);
  if (!backlogEntry) {
    fail(`managed task ${boardEntry.taskIdentifier} is missing a backlog entry`);
  }

  const expectedScopeName = normalizeScopeName(backlogEntry.scope);
  const boardScopeName = normalizeScopeName(boardEntry.scopeName);
  if (boardScopeName !== expectedScopeName) {
    fail(
      `scope contract mismatch for ${boardEntry.taskIdentifier}: ` +
      `board=${boardScopeName} backlog=${expectedScopeName}`,
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
  assertManagedTaskScopeContract(boardEntry);
  assertBranchHasCommittedChanges(boardEntry);
  assertWorktreeClean(boardEntry);

  const changedPaths = listChangedPathsAgainstMain(boardEntry.branchName);
  assertScopeBoundaries(boardEntry, changedPaths);
  runQualityGates(boardEntry);

  console.log(
    `review-ready passed for task=${boardEntry.taskIdentifier} branch=${boardEntry.branchName} scope=${boardEntry.scopeName}`,
  );
}

/**
 * Pushes the task branch to origin and sets upstream when needed.
 *
 * @param boardEntry - Task row details.
 */
function pushTaskBranch(boardEntry: TaskBoardEntry): void {
  const worktreePath = resolveWorktreePath(boardEntry.branchName);
  if (!existsSync(worktreePath)) {
    fail(`pushTaskBranch failed: missing worktree path ${worktreePath}`);
  }

  try {
    execFileSync("git", ["push", "-u", "origin", boardEntry.branchName], {
      cwd: worktreePath,
      stdio: "inherit",
    });
  } catch (caughtError) {
    fail(`pushTaskBranch(${boardEntry.taskIdentifier}) failed: ${formatError(caughtError)}`);
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
      "- Run: bun run quality:gates && bun run lint && bun run typecheck && bun run test && bun run build",
    );
    console.log("- Use TSDoc for documentation behavior notes.");
    console.log("- No inline comments.");
    console.log("- No single-letter or abbreviated variable names.");
    console.log("- Do not run gh pr create manually.");
    console.log("- Task is complete only after: quality gates pass, branch is pushed, and PR URL is posted.");
    console.log("- Finalize with one command: bun run ops:finish -- <task-id>");
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
  const [primaryScopePath] = parseScopePaths(boardEntry.scopeName);
  const scopeLabel = getLastPathSegment(primaryScopePath ?? boardEntry.scopeName);
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
  let taskGoal = `deliver task \`${boardEntry.taskIdentifier}\` in scope \`${boardEntry.scopeName}\``;
  try {
    const taskFilePath = loadTaskFile(boardEntry.taskIdentifier);
    const taskFileContents = readFileSync(taskFilePath, "utf8");
    taskGoal = extractTaskGoal(taskFileContents) ?? taskGoal;
  } catch (caughtError) {
    throw new Error(
      `Failed to read task file for ${boardEntry.taskIdentifier} (${boardEntry.scopeName}): ${formatError(caughtError)}`,
    );
  }
  const changedPathList = changedPaths
    .map((changedPath) => `- \`${changedPath}\``)
    .join("\n");

  return `## Summary

- task goal: ${taskGoal}
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
      ["pr", "list", "--state", "open", "--head", branchName, "--json", "number,url", "--limit", "1"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    const parsedResult = JSON.parse(rawResult) as Array<Partial<PullRequestReference>>;
    const firstPullRequest = parsedResult[0];
    if (
      firstPullRequest &&
      typeof firstPullRequest.number === "number" &&
      typeof firstPullRequest.url === "string"
    ) {
      return {
        number: firstPullRequest.number,
        url: firstPullRequest.url,
      };
    }

    return null;
  } catch (caughtError) {
    const errorText = formatError(caughtError);
    if (errorText.includes("error connecting to api.github.com")) {
      throw new Error(
        `findPullRequestByHead(${branchName}) failed in ${repositoryRoot}: GitHub API is unreachable`,
      );
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
  const worktreePath = resolveWorktreePath(branchName);
  const changedPaths = listChangedPathsAgainstMain(branchName);
  const pullRequestTitle = buildPullRequestTitle(boardEntry);
  let pullRequestBody = "";
  try {
    pullRequestBody = buildPullRequestBody(boardEntry, changedPaths);
  } catch (caughtError) {
    fail(`openPullRequestForTask(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
  const pullRequestBodyFilePath = resolve(
    runtimeOpsDirectoryPath,
    `pr-body-${taskIdentifier}.md`,
  );

  try {
    const existingPullRequest = findPullRequestByHead(branchName);
    pushTaskBranch(boardEntry);
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
    const errorText = formatError(caughtError);
    if (errorText.includes("error connecting to api.github.com")) {
      fail(
        `openPullRequestForTask(${taskIdentifier}) failed: GitHub API is unreachable. ` +
        `Retry later or run manually:\n` +
        `git -C ${worktreePath} push -u origin ${branchName}\n` +
        `gh pr create --base main --head ${branchName} --title ${JSON.stringify(pullRequestTitle)} --body-file ${pullRequestBodyFilePath}`,
      );
    }

    fail(`openPullRequestForTask(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
}

/**
 * Runs the full completion flow for one task.
 *
 * @param taskIdentifier - Unique task identifier.
 */
function finishTask(taskIdentifier: string): void {
  openPullRequestForTask(taskIdentifier);
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

  const scopeContract = resolveTaskScopeContract(taskIdentifier, scopeName);
  const options: StartCommandOptions = {
    taskIdentifier,
    branchName,
    ownerName,
    scopeName: scopeContract.scopeName,
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
 * Starts multiple session tasks and worktrees with deterministic agent ownership.
 *
 * @param argumentsList - Positional CLI args passed after `start-batch`.
 */
function startBatchSession(argumentsList: string[]): void {
  const [sessionIdentifier, ...taskIdentifiers] = argumentsList;
  if (!sessionIdentifier || taskIdentifiers.length === 0) {
    usage();
    fail("missing required arguments for ops:start-batch");
  }

  validateSegment(sessionIdentifier, "session-id");
  const ownershipEntries = loadOwnershipEntries();
  const createdOptions: StartCommandOptions[] = [];

  for (const [taskIndex, taskIdentifier] of taskIdentifiers.entries()) {
    validateSegment(taskIdentifier, "task-id");

    const ownerName = `agent-${taskIndex + 1}`;
    const inferredScopeName = inferScopeName(taskIdentifier, ownershipEntries);
    const scopeContract = resolveTaskScopeContract(taskIdentifier, inferredScopeName);
    const branchName = buildSessionBranchName(
      sessionIdentifier,
      taskIdentifier,
      "feat",
    );

    const options: StartCommandOptions = {
      taskIdentifier,
      branchName,
      ownerName,
      scopeName: scopeContract.scopeName,
    };

    ensureTaskFile(options);
    addBoardRowToInProgress(options);
    createWorktree(branchName);
    createdOptions.push(options);
  }

  console.log("\nBatch started.");
  console.log(`Session: ${sessionIdentifier}`);
  console.log(`Tasks: ${createdOptions.length}`);
  console.log("\nAgent Terminal Commands:");
  for (const createdOption of createdOptions) {
    console.log(
      `- ${createdOption.ownerName}: cd ${JSON.stringify(sharedRepositoryRoot)} && bun run ops:launch-agent -- ${createdOption.taskIdentifier}`,
    );
  }

  console.log("\nTech Lead Commands:");
  console.log("- bun run ops:status");
  console.log(`- bun run ops:validate-session -- ${sessionIdentifier}`);
  console.log("- Always open PRs via ops:open-pr (never manual gh pr create) to normalize title/body.");
  for (const createdOption of createdOptions) {
    console.log(
      `- bun run ops:review-ready -- ${createdOption.taskIdentifier} && bun run ops:open-pr -- ${createdOption.taskIdentifier}`,
    );
  }
  console.log(`- bun run wt:cleanup:session ${sessionIdentifier}`);
}

/**
 * Launches Codex in the task worktree with a preloaded execution instruction.
 *
 * @param taskIdentifier - Unique task identifier.
 */
function launchAgent(taskIdentifier: string): void {
  const boardEntry = resolveTaskBoardEntry(taskIdentifier);
  assertManagedTaskScopeContract(boardEntry);
  const worktreePath = resolveWorktreePath(boardEntry.branchName);
  if (!existsSync(worktreePath)) {
    fail(`launchAgent(${taskIdentifier}) failed: missing worktree path ${worktreePath}`);
  }

  const taskFilePath = loadTaskFile(taskIdentifier);
  const launchPrompt =
    `Read ${taskFilePath} and execute. ` +
    `Finish with: bun run ops:finish -- ${taskIdentifier}`;

  try {
    execFileSync(
      "codex",
      ["--cd", worktreePath, launchPrompt],
      {
        cwd: sharedRepositoryRoot,
        stdio: "inherit",
      },
    );
  } catch (caughtError) {
    fail(`launchAgent(${taskIdentifier}) failed: ${formatError(caughtError)}`);
  }
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
 * Validates one session board/worktree/task contract before launching agents.
 *
 * @param argumentsList - Positional CLI args passed after `validate-session`.
 */
function validateSession(argumentsList: string[]): void {
  const [sessionIdentifier] = argumentsList;
  if (!sessionIdentifier) {
    usage();
    fail("missing session-id for ops:validate-session");
  }

  validateSegment(sessionIdentifier, "session-id");
  const sessionMarker = `/${sessionIdentifier}-`;
  const sessionEntries = loadTaskBoardEntries().filter((boardEntry) =>
    boardEntry.branchName.includes(sessionMarker)
  );
  if (sessionEntries.length === 0) {
    fail(`ops:validate-session found no board rows for session ${sessionIdentifier}`);
  }

  for (const sessionEntry of sessionEntries) {
    assertTaskBranchAlignment(sessionEntry);
    assertManagedTaskScopeContract(sessionEntry);
    loadTaskFile(sessionEntry.taskIdentifier);

    const worktreePath = resolveWorktreePath(sessionEntry.branchName);
    if (!existsSync(worktreePath)) {
      fail(
        `ops:validate-session failed for ${sessionEntry.taskIdentifier}: missing worktree path ${worktreePath}`,
      );
    }
  }

  console.log(
    `validate-session passed for ${sessionIdentifier} with ${sessionEntries.length} task(s)`,
  );
}

/**
 * Returns true when a tmux session with the given name exists.
 *
 * @param sessionName - Candidate tmux session name.
 * @returns Whether the session exists.
 */
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Launches one tmux session with one window per task and starts Codex in each window.
 *
 * @param argumentsList - Positional CLI args passed after `tmux-batch`.
 */
function startTmuxBatch(argumentsList: string[]): void {
  const [sessionIdentifier, ...taskIdentifiers] = argumentsList;
  if (!sessionIdentifier || taskIdentifiers.length === 0) {
    usage();
    fail("missing required arguments for ops:tmux-batch");
  }

  const tmuxSessionName = `mergewise-${sessionIdentifier}`;
  if (tmuxSessionExists(tmuxSessionName)) {
    fail(
      `ops:tmux-batch failed: tmux session ${tmuxSessionName} already exists; ` +
      "attach to it or kill it first",
    );
  }

  startBatchSession(argumentsList);
  validateSession([sessionIdentifier]);
  const shellPath = process.env.SHELL ?? "/bin/sh";
  const loginShellCommand = shellPath === "/bin/sh"
    ? `exec ${JSON.stringify(shellPath)}`
    : `exec ${JSON.stringify(shellPath)} -l`;
  const wrapShellCommand = (command: string): string =>
    `${JSON.stringify(shellPath)} -lc ${JSON.stringify(command)}`;

  const buildWindowCommand = (taskIdentifier: string): string => {
    const launchCommand =
      `cd ${JSON.stringify(sharedRepositoryRoot)} && ` +
      `bun run ops:launch-agent -- ${taskIdentifier}`;
    return wrapShellCommand(launchCommand);
  };

  const [firstTaskIdentifier, ...remainingTaskIdentifiers] = taskIdentifiers;
  if (!firstTaskIdentifier) {
    fail("ops:tmux-batch failed: missing first task identifier");
  }

  try {
    execFileSync(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        tmuxSessionName,
        "-n",
        "agent-1",
        buildWindowCommand(firstTaskIdentifier),
      ],
      { stdio: "inherit" },
    );

    for (const [taskIndex, taskIdentifier] of remainingTaskIdentifiers.entries()) {
      const windowName = `agent-${taskIndex + 2}`;
      execFileSync(
        "tmux",
        [
          "new-window",
          "-t",
          tmuxSessionName,
          "-n",
          windowName,
          buildWindowCommand(taskIdentifier),
        ],
        { stdio: "inherit" },
      );
    }

    const monitorWindowCommand =
      `cd ${JSON.stringify(sharedRepositoryRoot)} && ` +
      `echo \"Tech Lead Monitor\" && ` +
      `echo \"- bun run ops:status\" && ` +
      `echo \"- bun run ops:review-ready -- <task-id> && bun run ops:open-pr -- <task-id>\" && ` +
      loginShellCommand;
    execFileSync(
      "tmux",
      [
        "new-window",
        "-t",
        tmuxSessionName,
        "-n",
        "tech-lead",
        wrapShellCommand(monitorWindowCommand),
      ],
      { stdio: "inherit" },
    );

    console.log(`\nTmux session ready: ${tmuxSessionName}`);
    console.log(`Attach: tmux attach -t ${tmuxSessionName}`);
  } catch (caughtError) {
    fail(`ops:tmux-batch failed: ${formatError(caughtError)}`);
  }
}

/**
 * Runs post-session cleanup and prints current workspace status.
 */
function resetWorkspace(): void {
  try {
    execFileSync(
      "bash",
      [resolve(repositoryRoot, "scripts/worktree.sh"), "cleanup-all"],
      {
        cwd: sharedRepositoryRoot,
        stdio: "inherit",
      },
    );
    execFileSync(
      "bash",
      [resolve(repositoryRoot, "scripts/worktree.sh"), "prune"],
      {
        cwd: sharedRepositoryRoot,
        stdio: "inherit",
      },
    );
    execFileSync(
      "bash",
      [resolve(repositoryRoot, "scripts/ops-status.sh")],
      {
        cwd: sharedRepositoryRoot,
        stdio: "inherit",
      },
    );
  } catch (caughtError) {
    fail(`ops:reset failed: ${formatError(caughtError)}`);
  }
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

  if (commandName === "start-batch") {
    startBatchSession(argumentsList);
    return;
  }

  if (commandName === "tmux-batch") {
    startTmuxBatch(argumentsList);
    return;
  }

  if (commandName === "validate-session") {
    validateSession(argumentsList);
    return;
  }

  if (commandName === "reset") {
    resetWorkspace();
    return;
  }

  if (commandName === "agent") {
    startAgentSession(argumentsList);
    return;
  }

  if (commandName === "launch-agent") {
    const [taskIdentifier] = argumentsList;
    if (!taskIdentifier) {
      usage();
      fail("missing task-id for ops:launch-agent");
    }

    launchAgent(taskIdentifier);
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

  if (commandName === "finish") {
    const [taskIdentifier] = argumentsList;
    if (!taskIdentifier) {
      usage();
      fail("missing task-id for ops:finish");
    }

    finishTask(taskIdentifier);
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
