import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

/**
 * Filename used for repository-level Mergewise configuration.
 */
export const DEFAULT_CONFIG_FILE_NAME = ".mergewise.yml";

/**
 * Runtime gating settings applied during finding filtering.
 */
export interface MergewiseGatingConfigV1 {
  /**
   * Minimum confidence score required for a finding to pass gating.
   */
  confidenceThreshold: number;
  /**
   * Maximum number of findings that may be posted for a pull request.
   */
  maxComments: number;
}

/**
 * Mergewise rule selection settings.
 */
export interface MergewiseRulesConfigV1 {
  /**
   * Rule identifiers explicitly enabled for analysis.
   */
  include: string[];
  /**
   * Rule identifiers explicitly disabled for analysis.
   */
  exclude: string[];
}

/**
 * Normalized Mergewise configuration.
 */
export interface MergewiseConfigV1 {
  /**
   * Gating-related thresholds and caps.
   */
  gating: MergewiseGatingConfigV1;
  /**
   * Rule selection lists.
   */
  rules: MergewiseRulesConfigV1;
}

/**
 * Optional loader arguments for resolving config location.
 */
export interface LoadMergewiseConfigOptionsV1 {
  /**
   * Base directory where `.mergewise.yml` is resolved.
   */
  workingDirectory?: string;
  /**
   * Override for config filename.
   */
  fileName?: string;
}

/**
 * Backward-compatible alias for the v1 gating config shape.
 */
export type MergewiseGatingConfig = MergewiseGatingConfigV1;

/**
 * Backward-compatible alias for the v1 rule selection config shape.
 */
export type MergewiseRulesConfig = MergewiseRulesConfigV1;

/**
 * Backward-compatible alias for the v1 normalized config shape.
 */
export type MergewiseConfig = MergewiseConfigV1;

/**
 * Backward-compatible alias for the v1 loader options shape.
 */
export type LoadMergewiseConfigOptions = LoadMergewiseConfigOptionsV1;

/**
 * Error raised when reading the config file fails.
 */
export class MergewiseConfigReadError extends Error {
  /**
   * Absolute path to the config file.
   */
  filePath: string;

  /**
   * Creates a read error with location context.
   *
   * @param filePath - Absolute path to config file.
   * @param details - Read failure details.
   * @param cause - Optional underlying error.
   */
  constructor(filePath: string, details: string, cause?: unknown) {
    super(`Unable to read Mergewise config in ${filePath}: ${details}`, { cause });
    this.name = "MergewiseConfigReadError";
    this.filePath = filePath;
  }
}

/**
 * Error raised when YAML parsing fails.
 */
export class MergewiseConfigParseError extends Error {
  /**
   * Absolute path to the config file.
   */
  filePath: string;

  /**
   * Creates a parse error with location context.
   *
   * @param filePath - Absolute path to config file.
   * @param details - Parse failure details.
   */
  constructor(filePath: string, details: string) {
    super(`Invalid Mergewise YAML in ${filePath}: ${details}`);
    this.name = "MergewiseConfigParseError";
    this.filePath = filePath;
  }
}

/**
 * Error raised when parsed config does not satisfy schema constraints.
 */
export class MergewiseConfigValidationError extends Error {
  /**
   * Absolute path to the config file.
   */
  filePath: string;

  /**
   * Creates a schema validation error.
   *
   * @param filePath - Absolute path to config file.
   * @param details - Validation details.
   */
  constructor(filePath: string, details: string) {
    super(`Invalid Mergewise config in ${filePath}: ${details}`);
    this.name = "MergewiseConfigValidationError";
    this.filePath = filePath;
  }
}

/**
 * Default Mergewise configuration applied when file is missing or fields are omitted.
 */
export const DEFAULT_MERGEWISE_CONFIG: MergewiseConfig = {
  gating: {
    confidenceThreshold: 0.78,
    maxComments: 20,
  },
  rules: {
    include: [],
    exclude: [],
  },
};

type RawMergewiseConfig = {
  gating?: {
    confidenceThreshold?: unknown;
    maxComments?: unknown;
  };
  rules?: {
    include?: unknown;
    exclude?: unknown;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaults(): MergewiseConfig {
  return {
    gating: { ...DEFAULT_MERGEWISE_CONFIG.gating },
    rules: {
      include: [...DEFAULT_MERGEWISE_CONFIG.rules.include],
      exclude: [...DEFAULT_MERGEWISE_CONFIG.rules.exclude],
    },
  };
}

function toRuleList(value: unknown, fieldPath: string, filePath: string): string[] {
  if (!Array.isArray(value)) {
    throw new MergewiseConfigValidationError(filePath, `${fieldPath} must be an array of strings`);
  }

  const normalizedRules = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new MergewiseConfigValidationError(
        filePath,
        `${fieldPath}[${index}] must be a non-empty string`,
      );
    }

    return entry;
  });

  return normalizedRules;
}

function applyGating(
  rawConfig: RawMergewiseConfig,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  if (rawConfig.gating === undefined) {
    return;
  }

  if (!isPlainObject(rawConfig.gating)) {
    throw new MergewiseConfigValidationError(filePath, "gating must be an object");
  }

  const confidenceThreshold = rawConfig.gating.confidenceThreshold;
  if (confidenceThreshold !== undefined) {
    if (typeof confidenceThreshold !== "number" || Number.isNaN(confidenceThreshold)) {
      throw new MergewiseConfigValidationError(filePath, "gating.confidenceThreshold must be a number");
    }

    if (confidenceThreshold < 0 || confidenceThreshold > 1) {
      throw new MergewiseConfigValidationError(
        filePath,
        "gating.confidenceThreshold must be between 0 and 1",
      );
    }

    normalizedConfig.gating.confidenceThreshold = confidenceThreshold;
  }

  const maxComments = rawConfig.gating.maxComments;
  if (maxComments !== undefined) {
    if (
      typeof maxComments !== "number" ||
      !Number.isInteger(maxComments) ||
      maxComments < 1
    ) {
      throw new MergewiseConfigValidationError(
        filePath,
        "gating.maxComments must be an integer greater than or equal to 1",
      );
    }

    normalizedConfig.gating.maxComments = maxComments;
  }
}

function applyRules(
  rawConfig: RawMergewiseConfig,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  if (rawConfig.rules === undefined) {
    return;
  }

  if (!isPlainObject(rawConfig.rules)) {
    throw new MergewiseConfigValidationError(filePath, "rules must be an object");
  }

  if (rawConfig.rules.include !== undefined) {
    normalizedConfig.rules.include = toRuleList(rawConfig.rules.include, "rules.include", filePath);
  }

  if (rawConfig.rules.exclude !== undefined) {
    normalizedConfig.rules.exclude = toRuleList(rawConfig.rules.exclude, "rules.exclude", filePath);
  }
}

function parseRawConfig(filePath: string): unknown {
  let rawYaml = "";
  try {
    rawYaml = readFileSync(filePath, "utf8");
  } catch (caughtError) {
    const details =
      caughtError instanceof Error ? caughtError.message : String(caughtError);
    throw new MergewiseConfigReadError(filePath, details, caughtError);
  }

  const yamlDocument = parseDocument(rawYaml);

  if (yamlDocument.errors.length > 0) {
    const details = yamlDocument.errors.map((yamlError) => yamlError.message).join("; ");
    throw new MergewiseConfigParseError(filePath, details);
  }

  return yamlDocument.toJSON();
}

function normalizeConfig(rawValue: unknown, filePath: string): MergewiseConfig {
  if (!isPlainObject(rawValue)) {
    throw new MergewiseConfigValidationError(filePath, "top-level config must be an object");
  }

  const rawConfig = rawValue as RawMergewiseConfig;
  const normalizedConfig = cloneDefaults();

  applyGating(rawConfig, normalizedConfig, filePath);
  applyRules(rawConfig, normalizedConfig, filePath);

  return normalizedConfig;
}

/**
 * Loads and validates `.mergewise.yml` from disk.
 *
 * @remarks
 * When the config file does not exist, defaults are returned.
 * Parse and schema errors throw explicit typed errors.
 *
 * @param options - Optional location overrides.
 * @returns Normalized config with defaults applied.
 */
export function loadMergewiseConfig(
  options: LoadMergewiseConfigOptions = {},
): MergewiseConfig {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const fileName = options.fileName ?? DEFAULT_CONFIG_FILE_NAME;
  const filePath = resolve(workingDirectory, fileName);

  if (!existsSync(filePath)) {
    return cloneDefaults();
  }

  const rawConfig = parseRawConfig(filePath);
  return normalizeConfig(rawConfig, filePath);
}
