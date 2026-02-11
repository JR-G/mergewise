import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_MERGEWISE_CONFIG,
  loadMergewiseConfig,
  MergewiseConfigParseError,
  MergewiseConfigReadError,
  MergewiseConfigValidationError,
} from "./index";

function createTempDirectory(): string {
  const path = join(tmpdir(), `mergewise-config-loader-test-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("config-loader", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = createTempDirectory();
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  test("returns defaults when .mergewise.yml is missing", () => {
    const config = loadMergewiseConfig({ workingDirectory: tempDirectory });
    expect(config).toEqual(DEFAULT_MERGEWISE_CONFIG);
    expect(config).not.toBe(DEFAULT_MERGEWISE_CONFIG);
  });

  test("loads valid yaml and applies defaults for omitted fields", () => {
    const filePath = join(tempDirectory, ".mergewise.yml");
    writeFileSync(
      filePath,
      [
        "gating:",
        "  confidenceThreshold: 0.9",
        "rules:",
        "  include:",
        "    - ts-react/exhaustive-deps-missing",
      ].join("\n"),
      "utf8",
    );

    const config = loadMergewiseConfig({ workingDirectory: tempDirectory });

    expect(config.gating.confidenceThreshold).toBe(0.9);
    expect(config.gating.maxComments).toBe(DEFAULT_MERGEWISE_CONFIG.gating.maxComments);
    expect(config.rules.include).toEqual(["ts-react/exhaustive-deps-missing"]);
    expect(config.rules.exclude).toEqual([]);
  });

  test("throws parse error for invalid yaml", () => {
    const filePath = join(tempDirectory, ".mergewise.yml");
    writeFileSync(filePath, "gating:\n  confidenceThreshold: [", "utf8");

    expect(() => loadMergewiseConfig({ workingDirectory: tempDirectory })).toThrow(
      MergewiseConfigParseError,
    );

    try {
      loadMergewiseConfig({ workingDirectory: tempDirectory });
      throw new Error("expected loadMergewiseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MergewiseConfigParseError);
      expect((error as Error).message).toContain("Invalid Mergewise YAML");
    }
  });

  test("throws read error when config path cannot be read as a file", () => {
    const filePath = join(tempDirectory, ".mergewise.yml");
    mkdirSync(filePath, { recursive: true });

    expect(() => loadMergewiseConfig({ workingDirectory: tempDirectory })).toThrow(
      MergewiseConfigReadError,
    );

    try {
      loadMergewiseConfig({ workingDirectory: tempDirectory });
      throw new Error("expected loadMergewiseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MergewiseConfigReadError);
      expect((error as Error).message).toContain("Unable to read Mergewise config");
    }
  });

  test("throws schema error for invalid confidenceThreshold", () => {
    const filePath = join(tempDirectory, ".mergewise.yml");
    writeFileSync(filePath, "gating:\n  confidenceThreshold: 2", "utf8");

    expect(() => loadMergewiseConfig({ workingDirectory: tempDirectory })).toThrow(
      MergewiseConfigValidationError,
    );

    try {
      loadMergewiseConfig({ workingDirectory: tempDirectory });
      throw new Error("expected loadMergewiseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MergewiseConfigValidationError);
      expect((error as Error).message).toContain("gating.confidenceThreshold");
    }
  });

  test("throws schema error for non-string rule entries", () => {
    const filePath = join(tempDirectory, ".mergewise.yml");
    writeFileSync(
      filePath,
      ["rules:", "  include:", "    - valid/rule", "    - 42"].join("\n"),
      "utf8",
    );

    expect(() => loadMergewiseConfig({ workingDirectory: tempDirectory })).toThrow(
      MergewiseConfigValidationError,
    );

    try {
      loadMergewiseConfig({ workingDirectory: tempDirectory });
      throw new Error("expected loadMergewiseConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MergewiseConfigValidationError);
      expect((error as Error).message).toContain("rules.include[1]");
    }
  });
});
