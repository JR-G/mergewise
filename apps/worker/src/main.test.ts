import { describe, expect, test } from "bun:test";

import {
  createShutdownSignalHandler,
  type WorkerShutdownSignal,
} from "./main";

function invokeSignalHandler(
  handler: (signal: WorkerShutdownSignal) => void,
  signal: WorkerShutdownSignal,
): void {
  handler(signal);
}

describe("createShutdownSignalHandler", () => {
  test("handles repeated signals with one shutdown execution", async () => {
    let shutdownCallCount = 0;
    const exitCodes: number[] = [];
    let resolveShutdown: () => void = () => {};
    const shutdownStarted = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });

    const signalHandler = createShutdownSignalHandler({
      shutdown: async () => {
        shutdownCallCount += 1;
        await shutdownStarted;
      },
      exitFn: (exitCode) => {
        exitCodes.push(exitCode);
      },
      logInfo: () => {},
      logError: () => {},
    });

    invokeSignalHandler(signalHandler, "SIGTERM");
    invokeSignalHandler(signalHandler, "SIGINT");
    await Promise.resolve();
    expect(shutdownCallCount).toBe(1);
    expect(exitCodes).toEqual([]);

    resolveShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(exitCodes).toEqual([0]);
  });

  test("exits with failure code when shutdown throws", async () => {
    const exitCodes: number[] = [];
    const signalHandler = createShutdownSignalHandler({
      shutdown: async () => {
        throw new Error("shutdown failed");
      },
      exitFn: (exitCode) => {
        exitCodes.push(exitCode);
      },
      logInfo: () => {},
      logError: () => {},
    });

    invokeSignalHandler(signalHandler, "SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });
});
