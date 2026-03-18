import { describe, test, expect } from "bun:test";

import { createTestEnvironment } from "./test-environment";

describe("test-environment", () => {
  test("createTestEnvironment creates isolated directories and stores", () => {
    const env = createTestEnvironment();

    expect(env.tempDir).toBeDefined();
    expect(env.jobFilePath).toContain("jobs.ndjson");
    expect(env.offsetFilePath).toContain("jobs.offset");
    expect(env.debtStore).toBeDefined();
    expect(env.feedbackStore).toBeDefined();
    expect(env.cleanup).toBeInstanceOf(Function);

    env.cleanup();
  });

  test("createTestEnvironment with empty GitHub config creates empty stubs", () => {
    const env = createTestEnvironment({});

    expect(env.githubStubs.recorded.createCheckRun).toHaveLength(0);
    expect(env.githubStubs.recorded.updateCheckRun).toHaveLength(0);

    env.cleanup();
  });

  test("createTestEnvironment captures log messages", () => {
    const env = createTestEnvironment();

    env.logInfo("test message");
    env.logError("test error");

    expect(env.capturedLogs).toContain("test message");
    expect(env.capturedErrors).toContain("test error");

    env.cleanup();
  });
});
