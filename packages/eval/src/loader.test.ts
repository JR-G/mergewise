import { describe, it, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toRepoFullName, toPRNumber } from "@mergewise/shared-types";
import { discoverFixtures, loadFixture, STUB_PR_METADATA } from "./loader";

describe("STUB_PR_METADATA", () => {
  it("has the expected fixture repo name", () => {
    expect(STUB_PR_METADATA.repo).toBe(toRepoFullName("eval/fixture"));
  });

  it("has prNumber set to one", () => {
    expect(STUB_PR_METADATA.prNumber).toBe(toPRNumber(1));
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
    const emptyDir = await mkdtemp(join(tmpdir(), "eval-test-empty-"));
    try {
      const fixtures = await discoverFixtures(emptyDir);
      expect(fixtures).toEqual([]);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("loadFixture", () => {
  it("loads a valid fixture with diff and expectations", async () => {
    const fixture = await loadFixture("clean-utility-functions");
    expect(fixture.fixtureId).toBe("clean-utility-functions");
    expect(fixture.fileDiff.filePath).toBeDefined();
    expect(Array.isArray(fixture.expectations)).toBe(true);
    expect(fixture.sourceFiles instanceof Map).toBe(true);
  });

  it("throws for a nonexistent fixture directory", async () => {
    let thrownError: unknown;
    try {
      await loadFixture("nonexistent-fixture-that-does-not-exist");
    } catch (error) {
      thrownError = error;
    }
    expect(thrownError).toBeDefined();
  });

  it("includes expectations with required boolean field", async () => {
    const fixture = await loadFixture("clean-utility-functions");
    for (const expectation of fixture.expectations) {
      expect(typeof expectation.required).toBe("boolean");
    }
  });

  it("sets fixtureId to the directory name", async () => {
    const fixtures = await discoverFixtures();
    expect(fixtures.length).toBeGreaterThan(0);
    const firstName = fixtures[0]!;
    const fixture = await loadFixture(firstName);
    expect(fixture.fixtureId).toBe(firstName);
  });

  it("loads optional fixture quality metadata when present", async () => {
    const fixture = await loadFixture("god-component");
    expect(fixture.config.executionMode).toBe("pipeline");
    expect(fixture.config.reviewQuality?.summary).toContain("single React component");
  });

  it("throws for a fixture with invalid diff.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "eval-test-malformed-diff-"));
    const fixtureDir = join(tempDir, "bad-diff");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(join(fixtureDir, "diff.json"), "{ not valid json !!!");
    await writeFile(join(fixtureDir, "expectations.json"), "[]");

    try {
      let thrownError: unknown;
      try {
        await loadFixture("bad-diff", tempDir);
      } catch (error) {
        thrownError = error;
      }
      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain("diff.json");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for a fixture with non-array expectations.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "eval-test-malformed-exp-"));
    const fixtureDir = join(tempDir, "bad-expectations");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "diff.json"),
      JSON.stringify({ filePath: "test.ts", hunks: [] }),
    );
    await writeFile(join(fixtureDir, "expectations.json"), JSON.stringify({ not: "an array" }));

    try {
      let thrownError: unknown;
      try {
        await loadFixture("bad-expectations", tempDir);
      } catch (error) {
        thrownError = error;
      }
      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain("expected an array");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for a fixture with invalid fixture.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "eval-test-malformed-fixture-json-"));
    const fixtureDir = join(tempDir, "bad-fixture-json");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "diff.json"),
      JSON.stringify({ filePath: "test.ts", previousPath: null, hunks: [] }),
    );
    await writeFile(join(fixtureDir, "expectations.json"), "[]");
    await writeFile(join(fixtureDir, "fixture.json"), "{ not valid json");

    try {
      expect(loadFixture("bad-fixture-json", tempDir)).rejects.toThrow(
        /fixture\.json/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for a fixture with invalid executionMode in fixture.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "eval-test-invalid-fixture-mode-"));
    const fixtureDir = join(tempDir, "bad-fixture-mode");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "diff.json"),
      JSON.stringify({ filePath: "test.ts", previousPath: null, hunks: [] }),
    );
    await writeFile(join(fixtureDir, "expectations.json"), "[]");
    await writeFile(join(fixtureDir, "fixture.json"), JSON.stringify({ executionMode: "future-mode" }));

    try {
      expect(loadFixture("bad-fixture-mode", tempDir)).rejects.toThrow(
        /Invalid fixture\.json/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for a fixture with malformed reviewQuality in fixture.json", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "eval-test-invalid-review-quality-"));
    const fixtureDir = join(tempDir, "bad-review-quality");
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(
      join(fixtureDir, "diff.json"),
      JSON.stringify({ filePath: "test.ts", previousPath: null, hunks: [] }),
    );
    await writeFile(join(fixtureDir, "expectations.json"), "[]");
    await writeFile(
      join(fixtureDir, "fixture.json"),
      JSON.stringify({
        executionMode: "pipeline",
        reviewQuality: {
          mustFind: [],
          mustAvoid: [],
        },
      }),
    );

    try {
      expect(loadFixture("bad-review-quality", tempDir)).rejects.toThrow(
        /Invalid fixture\.json/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
