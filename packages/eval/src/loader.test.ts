import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { discoverFixtures, loadFixture, STUB_PR_METADATA } from "./loader";

describe("STUB_PR_METADATA", () => {
  it("has the expected fixture repo name", () => {
    expect(STUB_PR_METADATA.repo).toBe("eval/fixture");
  });

  it("has prNumber set to zero", () => {
    expect(STUB_PR_METADATA.prNumber).toBe(0);
  });

  it("has a null installationId", () => {
    expect(STUB_PR_METADATA.installationId).toBeNull();
  });
});

describe("discoverFixtures", () => {
  it("returns an array of fixture directory names from the default directory", async () => {
    const fixtures = await discoverFixtures();
    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it("includes known fixture directories", async () => {
    const fixtures = await discoverFixtures();
    expect(fixtures.some((name) => name === "clean-utility-functions")).toBe(true);
  });

  it("returns empty array for a directory with no subdirectories", async () => {
    const emptyDir = join(import.meta.dirname);
    const fixtures = await discoverFixtures(emptyDir);
    expect(Array.isArray(fixtures)).toBe(true);
  });
});

describe("loadFixture", () => {
  it("loads a valid fixture with diff and expectations", async () => {
    const fixture = await loadFixture("clean-utility-functions");
    expect(fixture.fixtureId).toBe("clean-utility-functions");
    expect(fixture.fileDiff.filePath).toBeDefined();
    expect(Array.isArray(fixture.expectations)).toBe(true);
  });

  it("throws for a nonexistent fixture directory", async () => {
    expect(() => loadFixture("nonexistent-fixture-that-does-not-exist")).toThrow();
  });

  it("includes expectations with required boolean field", async () => {
    const fixture = await loadFixture("clean-utility-functions");
    for (const expectation of fixture.expectations) {
      expect(typeof expectation.required).toBe("boolean");
    }
  });

  it("sets fixtureId to the directory name", async () => {
    const fixtures = await discoverFixtures();
    const firstName = fixtures[0]!;
    const fixture = await loadFixture(firstName);
    expect(fixture.fixtureId).toBe(firstName);
  });
});
