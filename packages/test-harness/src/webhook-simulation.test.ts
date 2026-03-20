import { describe, test, expect } from "bun:test";

import { toRepoFullName, toPRNumber } from "@mergewise/shared-types";

import { buildTestPrPayload, buildTestPushPayload } from "./webhook-simulation";

describe("webhook-simulation", () => {
  test("buildTestPrPayload creates a valid PR webhook payload", () => {
    const payload = buildTestPrPayload("opened");

    expect(payload.action).toBe("opened");
    expect(payload.repository.full_name).toBe(toRepoFullName("test-org/test-repo"));
    expect(payload.pull_request.number).toBe(toPRNumber(42));
  });

  test("buildTestPushPayload creates a valid push webhook payload", () => {
    const payload = buildTestPushPayload();

    expect(payload.ref).toContain("refs/heads/");
    expect(payload.repository.full_name).toBe(toRepoFullName("test-org/test-repo"));
  });

  test("buildTestPrPayload with invalid action still creates payload", () => {
    const payload = buildTestPrPayload("unknown-action");

    expect(payload.action).toBe("unknown-action");
  });

  test("buildTestPushPayload creates valid ref field", () => {
    const payload = buildTestPushPayload();

    expect(payload.ref).toBeDefined();
  });
});
