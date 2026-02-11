#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
const boardFilePath = resolve(repositoryRoot, "ops/board.md");
const tasksDirectoryPath = resolve(repositoryRoot, "ops/tasks");
const taskTemplatePath = resolve(tasksDirectoryPath, "TEMPLATE.md");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function usage(): void {
  console.log(`Usage:
  bun run ops:start -- <task-id> <branch-name> <owner> <scope>
  bun run ops:prompt -- <task-id>

Examples:
  bun run ops:start -- github-client feat/agent-github-client alice packages/github-client
  bun run ops:prompt -- github-client`);
}

function ensureTaskFile(options: StartCommandOptions): string {
  if (!existsSync(taskTemplatePath)) {
    fail(`missing task template at ${taskTemplatePath}`);
  }

  mkdirSync(tasksDirectoryPath, { recursive: true });
  const taskFilePath = resolve(tasksDirectoryPath, `${options.taskIdentifier}.md`);

  if (!existsSync(taskFilePath)) {
    const templateBody = readFileSync(taskTemplatePath, "utf8");
    const preparedBody = templateBody
      .replace("<task-id>", options.taskIdentifier)
      .replace("`feat/<task-id>`", `\`${options.branchName}\``);
    writeFileSync(taskFilePath, preparedBody, "utf8");
  }

  return taskFilePath;
}

function ensureBoardFile(): void {
  if (existsSync(boardFilePath)) {
    return;
  }

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
}

function addBoardRowToInProgress(options: StartCommandOptions): void {
  ensureBoardFile();

  const boardContents = readFileSync(boardFilePath, "utf8");
  const rowText = `| ${options.taskIdentifier} | ${options.branchName} | ${options.ownerName} | ${options.scopeName} |`;

  if (boardContents.includes(rowText)) {
    return;
  }

  const inProgressSectionPattern =
    /(## In Progress\n\n\| Task ID \| Branch \| Owner \| Scope \|\n\| --- \| --- \| --- \| --- \|\n)/;
  if (!inProgressSectionPattern.test(boardContents)) {
    fail("board format invalid: missing In Progress table header");
  }

  const updatedBoardContents = boardContents.replace(
    inProgressSectionPattern,
    `$1${rowText}\n`,
  );

  writeFileSync(boardFilePath, updatedBoardContents, "utf8");
}

function createWorktree(branchName: string): void {
  execFileSync(
    "bash",
    [resolve(repositoryRoot, "scripts/worktree.sh"), "new", branchName],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  );
}

function loadTaskFile(taskIdentifier: string): string {
  const taskFilePath = resolve(tasksDirectoryPath, `${taskIdentifier}.md`);
  if (!existsSync(taskFilePath)) {
    fail(`task file not found: ${taskFilePath}`);
  }

  return taskFilePath;
}

function printPrompt(taskIdentifier: string): void {
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
}

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

    printPrompt(taskIdentifier);
    return;
  }

  usage();
  fail(`unknown command: ${commandName}`);
}

main();
