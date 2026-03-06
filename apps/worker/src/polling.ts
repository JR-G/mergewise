/**
 * Mutable state backing in-memory idempotency key tracking.
 *
 * @remarks
 * Both `keys` (for O(1) membership checks) and `order` (for FIFO eviction)
 * collections are mutated in place by {@link trackProcessedKey}.
 */
export interface ProcessedKeyState {
  /** Set of currently tracked keys for O(1) lookup. Mutated by trackProcessedKey. */
  readonly keys: Set<string>;
  /** Insertion-ordered list for FIFO eviction. Mutated by trackProcessedKey. */
  readonly order: string[];
}

/**
 * Mutable state tracking whether one poll cycle is currently active.
 */
export interface PollCycleState {
  /**
   * Indicates whether poll execution is currently in flight.
   */
  isPollInFlight: boolean;
}

/**
 * Timer handle type used by worker polling lifecycle controls.
 */
export type WorkerPollingTimerHandle = ReturnType<typeof setInterval>;

/**
 * Dependency overrides for polling loop interval lifecycle.
 */
export interface PollingLoopDependencies {
  /**
   * Interval scheduler implementation.
   */
  readonly setIntervalFn?: (
    callback: () => void,
    delayMs: number,
  ) => WorkerPollingTimerHandle;
  /**
   * Interval cancellation implementation.
   */
  readonly clearIntervalFn?: (timerHandle: WorkerPollingTimerHandle) => void;
  /**
   * Error logger for poll lifecycle failures.
   */
  readonly logError?: (message: string) => void;
}

/**
 * Lifecycle controller for worker polling intervals.
 */
export interface PollingLoopController {
  /**
   * Starts periodic polling when not already running.
   */
  start: () => void;
  /**
   * Stops periodic polling and waits for in-flight poll completion.
   */
  stop: () => Promise<void>;
  /**
   * Indicates whether the interval is currently active.
   */
  isRunning: () => boolean;
}

/**
 * Executes one poll cycle while preventing overlapping runs.
 *
 * @param state - Mutable poll cycle state.
 * @param pollCycle - Poll cycle callback.
 * @returns `true` when execution ran, or `false` when skipped due to in-flight work.
 */
export async function runPollCycleWithInFlightGuard(
  state: PollCycleState,
  pollCycle: () => Promise<void>,
): Promise<boolean> {
  if (state.isPollInFlight) {
    return false;
  }

  state.isPollInFlight = true;
  try {
    await pollCycle();
    return true;
  } finally {
    state.isPollInFlight = false;
  }
}

/**
 * Creates an interval-backed polling loop with graceful stop semantics.
 *
 * @remarks
 * `stop` clears the interval first and then waits for one in-flight cycle to finish.
 * Repeated stop requests while shutdown is in progress reuse the same promise.
 *
 * @param pollIntervalMs - Interval duration in milliseconds.
 * @param pollCycle - Poll cycle callback to execute on each tick.
 * @param dependencies - Optional interval and logging overrides for tests.
 * @returns Polling loop lifecycle controller.
 */
export function createPollingLoopController(
  pollIntervalMs: number,
  pollCycle: () => Promise<void>,
  dependencies: PollingLoopDependencies = {},
): PollingLoopController {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`pollIntervalMs must be a finite positive number, got: ${pollIntervalMs}`);
  }

  const setIntervalFn: NonNullable<PollingLoopDependencies["setIntervalFn"]> =
    dependencies.setIntervalFn ??
    ((callback: () => void, delayMs: number): WorkerPollingTimerHandle => setInterval(callback, delayMs));
  const clearIntervalFn: NonNullable<PollingLoopDependencies["clearIntervalFn"]> =
    dependencies.clearIntervalFn ??
    ((timerHandle: WorkerPollingTimerHandle): void => { clearInterval(timerHandle); });
  const errorLogger = dependencies.logError ?? console.error;

  let timerHandle: WorkerPollingTimerHandle | null = null;
  let inFlightPollPromise: Promise<void> | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let isShutdownRequested = false;

  const runPollCycle = (): void => {
    if (isShutdownRequested || inFlightPollPromise !== null) {
      return;
    }

    const pendingPollPromise = Promise.resolve().then(() => pollCycle()).catch((error: unknown) => {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      errorLogger(`[worker] poll cycle failed: ${details}`);
    });
    inFlightPollPromise = pendingPollPromise.finally(() => {
      if (inFlightPollPromise === pendingPollPromise) {
        inFlightPollPromise = null;
      }
    });
  };

  const start = (): void => {
    if (timerHandle !== null || shutdownPromise !== null) {
      return;
    }

    isShutdownRequested = false;
    timerHandle = setIntervalFn(() => {
      runPollCycle();
    }, pollIntervalMs);
  };

  const stop = async (): Promise<void> => {
    if (shutdownPromise !== null) {
      await shutdownPromise;
      return;
    }

    shutdownPromise = (async (): Promise<void> => {
      isShutdownRequested = true;
      if (timerHandle !== null) {
        clearIntervalFn(timerHandle);
        timerHandle = null;
      }

      if (inFlightPollPromise !== null) {
        await inFlightPollPromise;
      }
    })();

    try {
      await shutdownPromise;
    } finally {
      shutdownPromise = null;
    }
  };

  const isRunning = (): boolean => timerHandle !== null;

  return { start, stop, isRunning };
}

/**
 * Creates a fresh empty processed key tracking state.
 */
export function createProcessedKeyState(): ProcessedKeyState {
  return { keys: new Set(), order: [] };
}

/**
 * Tracks a processed idempotency key while enforcing a fixed-size in-memory cap.
 *
 * @remarks
 * Oldest keys are evicted first once `maxKeys` is exceeded, allowing
 * long-running worker processes to stay memory-bounded.
 *
 * @param key - Idempotency key for a completed job.
 * @param state - Mutable tracking state.
 * @param maxKeys - Maximum number of keys to retain.
 */
export function trackProcessedKey(
  key: string,
  state: ProcessedKeyState,
  maxKeys: number,
): void {
  if (state.keys.has(key)) {
    return;
  }

  const effectiveMaxKeys = Math.max(0, maxKeys);

  state.keys.add(key);
  state.order.push(key);

  while (state.order.length > effectiveMaxKeys) {
    const evicted = state.order.shift();
    if (evicted) {
      state.keys.delete(evicted);
    }
  }
}
