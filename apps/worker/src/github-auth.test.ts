import { afterEach, describe, expect, it } from "bun:test";

import { loadGitHubAppCredentials } from "./github-auth";

describe("loadGitHubAppCredentials", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when GITHUB_APP_ID is missing", () => {
    delete process.env["GITHUB_APP_ID"];
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PEM"];

    expect(() => loadGitHubAppCredentials()).toThrow("missing GITHUB_APP_ID");
  });

  it("throws when GITHUB_APP_ID is not a positive number", () => {
    process.env["GITHUB_APP_ID"] = "abc";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "FAKE_PRIVATE_KEY_CONTENT";

    expect(() => loadGitHubAppCredentials()).toThrow("invalid GITHUB_APP_ID value");
  });

  it("throws when GITHUB_APP_ID has trailing non-digit characters", () => {
    process.env["GITHUB_APP_ID"] = "123abc";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "FAKE_PRIVATE_KEY_CONTENT";

    expect(() => loadGitHubAppCredentials()).toThrow("invalid GITHUB_APP_ID value");
  });

  it("throws when GITHUB_APP_ID is a float", () => {
    process.env["GITHUB_APP_ID"] = "1.5";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "FAKE_PRIVATE_KEY_CONTENT";

    expect(() => loadGitHubAppCredentials()).toThrow("invalid GITHUB_APP_ID value");
  });

  it("throws when GITHUB_APP_ID is negative", () => {
    process.env["GITHUB_APP_ID"] = "-42";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "FAKE_PRIVATE_KEY_CONTENT";

    expect(() => loadGitHubAppCredentials()).toThrow("invalid GITHUB_APP_ID value");
  });

  it("throws when no private key source is available", () => {
    process.env["GITHUB_APP_ID"] = "12345";
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PEM"];

    expect(() => loadGitHubAppCredentials()).toThrow("missing GITHUB_APP_PRIVATE_KEY");
  });

  it("returns parsed credentials from GITHUB_APP_PRIVATE_KEY", () => {
    process.env["GITHUB_APP_ID"] = "42";
    process.env["GITHUB_APP_PRIVATE_KEY"] = "FAKE_PRIVATE_KEY_CONTENT";
    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PEM"];

    const credentials = loadGitHubAppCredentials();

    expect(credentials.appId).toBe(42);
    expect(credentials.privateKeyPem).toContain("FAKE_PRIVATE_KEY_CONTENT");
  });

  it("falls back to GITHUB_APP_PRIVATE_KEY_PEM when preferred key is missing", () => {
    process.env["GITHUB_APP_ID"] = "99";
    delete process.env["GITHUB_APP_PRIVATE_KEY"];
    delete process.env["GITHUB_APP_PRIVATE_KEY_PATH"];
    process.env["GITHUB_APP_PRIVATE_KEY_PEM"] = "FAKE_LEGACY_KEY_CONTENT";

    const credentials = loadGitHubAppCredentials();

    expect(credentials.appId).toBe(99);
    expect(credentials.privateKeyPem).toContain("FAKE_LEGACY_KEY_CONTENT");
  });
});
