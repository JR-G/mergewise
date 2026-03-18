import { describe, expect, it } from "bun:test";

import type { WorkerPollingTimerHandle } from "./polling";
import {
  runPollCycleWithInFlightGuard,
  createPollingLoopController,
  createProcessedKeyState,
  trackProcessedKey,
} from "./polling";

describe("runPollCycleWithInFlightGuard", () => {
  it("executes the poll cycle and returns true", async () => {
    let executed = false;
    const state = { isPollInFlight: false };

    const result = await runPollCycleWithInFlightGuard(state, async () => { executed = true; });

    expect(result).toBe(true);
    expect(executed).toBe(true);
  });

  it("skips execution when a poll is already in flight", async () => {
    const state = { isPollInFlight: true };

    const result = await runPollCycleWithInFlightGuard(state, async () => {});

    expect(result).toBe(false);
  });

  it("resets in-flight state even when the poll cycle throws", async () => {
    const state = { isPollInFlight: false };

    await runPollCycleWithInFlightGuard(state, async () => { throw new Error("boom"); }).catch(() => {});

    expect(state.isPollInFlight).toBe(false);
  });
});

describe("createPollingLoopController", () => {
  it("starts the interval and reports running state", () => {
    const timers: { callback: () => void; delay: number }[] = [];
    const controller = createPollingLoopController(1000, async () => {}, {
      setIntervalFn: (callback, delay) => { timers.push({ callback, delay }); return 1 as unknown as WorkerPollingTimerHandle; },
      clearIntervalFn: () => {},
    });

    controller.start();

    expect(controller.isRunning()).toBe(true);
    expect(timers.some((timer) => timer.delay === 1000)).toBe(true);
  });

  it("does not start a second interval when already running", () => {
    let setIntervalCallCount = 0;
    const controller = createPollingLoopController(500, async () => {}, {
      setIntervalFn: (_callback, _delay) => { setIntervalCallCount += 1; return 1 as unknown as WorkerPollingTimerHandle; },
      clearIntervalFn: () => {},
    });

    controller.start();
    controller.start();

    expect(setIntervalCallCount).toBe(1);
  });

  it("clears the interval on stop and reports not running", async () => {
    let cleared = false;
    const controller = createPollingLoopController(500, async () => {}, {
      setIntervalFn: (_callback, _delay) => 1 as unknown as WorkerPollingTimerHandle,
      clearIntervalFn: () => { cleared = true; },
    });

    controller.start();
    await controller.stop();

    expect(controller.isRunning()).toBe(false);
    expect(cleared).toBe(true);
  });

  it("waits for in-flight poll to finish before stop resolves", async () => {
    let cleared = false;
    let pollResolve: (() => void) | undefined;
    const pollPromise = new Promise<void>((resolve) => { pollResolve = resolve; });
    let capturedCallback: (() => void) | undefined;

    const controller = createPollingLoopController(500, () => pollPromise, {
      setIntervalFn: (callback, _delay) => { capturedCallback = callback; return 1 as unknown as WorkerPollingTimerHandle; },
      clearIntervalFn: () => { cleared = true; },
    });

    controller.start();
    capturedCallback?.();

    let stopResolved = false;
    const stopPromise = controller.stop().then(() => { stopResolved = true; });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cleared).toBe(true);
    expect(stopResolved).toBe(false);

    pollResolve?.();
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(controller.isRunning()).toBe(false);
  });

  it("logs errors from failing poll cycles without crashing", async () => {
    let loggedMessage = "";
    let capturedCallback: (() => void) | undefined;
    const controller = createPollingLoopController(
      100,
      async () => { throw new Error("poll failure"); },
      {
        setIntervalFn: (callback, _delay) => { capturedCallback = callback; return 1 as unknown as WorkerPollingTimerHandle; },
        clearIntervalFn: () => {},
        logError: (message) => { loggedMessage = message; },
      },
    );

    controller.start();
    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loggedMessage).toContain("poll cycle failed");
  });

  it("catches synchronous throws from the poll function", async () => {
    let loggedMessage = "";
    let capturedCallback: (() => void) | undefined;
    const controller = createPollingLoopController(
      100,
      () => { throw new Error("sync boom"); },
      {
        setIntervalFn: (callback, _delay) => { capturedCallback = callback; return 1 as unknown as WorkerPollingTimerHandle; },
        clearIntervalFn: () => {},
        logError: (message) => { loggedMessage = message; },
      },
    );

    controller.start();
    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(loggedMessage).toContain("poll cycle failed");
  });

  it("throws for NaN pollIntervalMs", () => {
    expect(() => createPollingLoopController(NaN, async () => {})).toThrow(
      "pollIntervalMs must be a finite positive number",
    );
  });

  it("throws for Infinity pollIntervalMs", () => {
    expect(() => createPollingLoopController(Infinity, async () => {})).toThrow(
      "pollIntervalMs must be a finite positive number",
    );
  });

  it("throws for negative pollIntervalMs", () => {
    expect(() => createPollingLoopController(-100, async () => {})).toThrow(
      "pollIntervalMs must be a finite positive number",
    );
  });

  it("throws for zero pollIntervalMs", () => {
    expect(() => createPollingLoopController(0, async () => {})).toThrow(
      "pollIntervalMs must be a finite positive number",
    );
  });

  it("continues polling after the first cycle completes", async () => {
    let pollCount = 0;
    let capturedCallback: (() => void) | undefined;

    const controller = createPollingLoopController(
      100,
      async () => { pollCount++; },
      {
        setIntervalFn: (callback, _delay) => { capturedCallback = callback; return 1 as unknown as WorkerPollingTimerHandle; },
        clearIntervalFn: () => {},
      },
    );

    controller.start();

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(1);

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(2);

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(3);
  });

  it("continues polling after the first cycle rejects", async () => {
    let pollCount = 0;
    let callIndex = 0;
    let capturedCallback: (() => void) | undefined;

    const controller = createPollingLoopController(
      100,
      async () => {
        callIndex++;
        if (callIndex === 1) {
          throw new Error("first poll failed");
        }
        pollCount++;
      },
      {
        setIntervalFn: (callback, _delay) => { capturedCallback = callback; return 1 as unknown as WorkerPollingTimerHandle; },
        clearIntervalFn: () => {},
        logError: () => {},
      },
    );

    controller.start();

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(0);

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(1);

    capturedCallback?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pollCount).toBe(2);
  });
});

describe("createProcessedKeyState", () => {
  it("returns an empty state", () => {
    const state = createProcessedKeyState();

    expect(state.keys.size).toBe(0);
    expect(state.order).toEqual([]);
  });
});

describe("trackProcessedKey", () => {
  it("adds a new key to the tracking state", () => {
    const state = createProcessedKeyState();

    trackProcessedKey("key-a", state, 10);

    expect(state.keys.has("key-a")).toBe(true);
  });

  it("does not duplicate an already-tracked key", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("key-a", state, 10);

    trackProcessedKey("key-a", state, 10);

    expect(state.order.filter((entry) => entry === "key-a")).toHaveLength(1);
  });

  it("evicts the oldest key when exceeding maxKeys", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("first", state, 2);
    trackProcessedKey("second", state, 2);

    trackProcessedKey("third", state, 2);

    expect(state.keys.has("first")).toBe(false);
    expect(state.keys.has("second")).toBe(true);
    expect(state.keys.has("third")).toBe(true);
  });

  it("handles maxKeys of zero by immediately evicting", () => {
    const state = createProcessedKeyState();

    trackProcessedKey("key-z", state, 0);

    expect(state.keys.has("key-z")).toBe(false);
    expect(state.order).toEqual([]);
  });

  it("treats negative maxKeys as zero", () => {
    const state = createProcessedKeyState();

    trackProcessedKey("key-neg", state, -5);

    expect(state.keys.has("key-neg")).toBe(false);
  });

  it("treats NaN maxKeys as zero and evicts immediately", () => {
    const state = createProcessedKeyState();

    trackProcessedKey("key-nan", state, NaN);

    expect(state.keys.has("key-nan")).toBe(false);
    expect(state.order).toEqual([]);
  });

  it("treats Infinity maxKeys as zero and evicts immediately", () => {
    const state = createProcessedKeyState();

    trackProcessedKey("key-inf", state, Infinity);

    expect(state.keys.has("key-inf")).toBe(false);
    expect(state.order).toEqual([]);
  });

  it("floors non-integer maxKeys to nearest integer", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("first", state, 1.9);
    trackProcessedKey("second", state, 1.9);

    expect(state.keys.has("first")).toBe(false);
    expect(state.keys.has("second")).toBe(true);
    expect(state.order).toEqual(["second"]);
  });
});
