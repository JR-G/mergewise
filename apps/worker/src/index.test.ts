import { afterEach, describe, expect, test } from "bun:test";

import {
  buildIdempotencyKey,
  createProcessedKeyState,
  loadConfig,
  trackProcessedKey,
} from "./index";

describe("buildIdempotencyKey", () => {
  test("produces repo#pr@sha format", () => {
    const key = buildIdempotencyKey({
      job_id: "j1",
      installation_id: 1,
      repo_full_name: "acme/widget",
      pr_number: 42,
      head_sha: "abc123",
      queued_at: "2025-01-01T00:00:00Z",
    });
    expect(key).toBe("acme/widget#42@abc123");
  });

  test("different SHA produces different key", () => {
    const base = {
      job_id: "j1",
      installation_id: 1,
      repo_full_name: "acme/widget",
      pr_number: 42,
      queued_at: "2025-01-01T00:00:00Z",
    };

    const keyA = buildIdempotencyKey({ ...base, head_sha: "aaa" });
    const keyB = buildIdempotencyKey({ ...base, head_sha: "bbb" });
    expect(keyA).not.toBe(keyB);
  });
});

describe("trackProcessedKey", () => {
  test("adds key to state", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("key-1", state, 10);
    expect(state.keys.has("key-1")).toBe(true);
    expect(state.order).toEqual(["key-1"]);
  });

  test("evicts oldest key at max capacity via FIFO", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("a", state, 2);
    trackProcessedKey("b", state, 2);
    trackProcessedKey("c", state, 2);

    expect(state.keys.has("a")).toBe(false);
    expect(state.keys.has("b")).toBe(true);
    expect(state.keys.has("c")).toBe(true);
    expect(state.order).toEqual(["b", "c"]);
  });

  test("preserves insertion order", () => {
    const state = createProcessedKeyState();
    trackProcessedKey("x", state, 5);
    trackProcessedKey("y", state, 5);
    trackProcessedKey("z", state, 5);
    expect(state.order).toEqual(["x", "y", "z"]);
  });
});

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.WORKER_POLL_INTERVAL_MS = originalEnv.WORKER_POLL_INTERVAL_MS;
    process.env.WORKER_MAX_PROCESSED_KEYS = originalEnv.WORKER_MAX_PROCESSED_KEYS;
  });

  test("returns defaults when env is unset", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    delete process.env.WORKER_MAX_PROCESSED_KEYS;
    const cfg = loadConfig();
    expect(cfg.pollIntervalMs).toBe(3000);
    expect(cfg.maxProcessedKeys).toBe(10000);
  });

  test("throws for below-minimum poll interval", () => {
    process.env.WORKER_POLL_INTERVAL_MS = "100";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });

  test("throws for below-minimum max keys", () => {
    delete process.env.WORKER_POLL_INTERVAL_MS;
    process.env.WORKER_MAX_PROCESSED_KEYS = "50";
    expect(() => loadConfig()).toThrow("Invalid WORKER_MAX_PROCESSED_KEYS value");
  });

  test("throws for non-numeric values", () => {
    process.env.WORKER_POLL_INTERVAL_MS = "abc";
    expect(() => loadConfig()).toThrow("Invalid WORKER_POLL_INTERVAL_MS value");
  });
});
