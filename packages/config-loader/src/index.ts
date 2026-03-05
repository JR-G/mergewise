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
 * Review behaviour settings for file selection and finding filtering.
 */
export interface MergewiseReviewConfigV1 {
  /**
   * User-defined glob patterns for files to exclude from LLM review.
   *
   * @remarks
   * Merged with built-in skip patterns — cannot replace them.
   */
  skipPatterns: string[];
}

/**
 * LLM reviewer settings for AI-powered code review.
 */
export interface MergewiseLlmConfigV1 {
  /**
   * Whether LLM review is enabled.
   *
   * @remarks
   * Defaults to `false`. Must be explicitly set to `true` in config, and
   * the `LLM_API_KEY` environment variable must also be set for the
   * reviewer to activate.
   */
  enabled: boolean;
  /**
   * Model identifier passed to the LLM provider.
   */
  model: string;
  /**
   * Maximum estimated tokens across all files selected for review.
   */
  tokenBudget: number;
  /**
   * Base URL for the OpenAI-compatible API endpoint.
   *
   * @remarks
   * Override this when using non-OpenAI providers (e.g. Anthropic's
   * OpenAI-compatible endpoint, Ollama, OpenRouter).
   */
  baseUrl: string;
  /**
   * Number of independent LLM samples for self-consistency filtering.
   *
   * @remarks
   * When greater than 1, each file is reviewed N times and only findings
   * that appear in the majority of runs are kept. Defaults to 1
   * (single-shot, no consensus filtering).
   */
  consistencySamples: number;
  /**
   * Model identifier for the triage pass (file classification).
   *
   * @remarks
   * Should be a fast, cheap model. Only used when the review pipeline
   * is enabled.
   */
  triageModel: string;
  /**
   * Model identifier for the critic pass (finding quality filter).
   *
   * @remarks
   * Should be a fast, cheap model. Only used when the review pipeline
   * is enabled.
   */
  criticModel: string;
}

/**
 * Mergewise rule selection settings.
 */
export interface MergewiseRulesConfigV1 {
  /**
   * Rule identifiers explicitly enabled for analysis.
   *
   * @remarks
   * Values are normalized by trimming surrounding whitespace during load.
   */
  include: string[];
  /**
   * Rule identifiers explicitly disabled for analysis.
   *
   * @remarks
   * Values are normalized by trimming surrounding whitespace during load.
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
  /**
   * Review behaviour settings.
   */
  review: MergewiseReviewConfigV1;
  /**
   * LLM reviewer settings.
   */
  llm: MergewiseLlmConfigV1;
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
 * Backward-compatible alias for the v1 review config shape.
 */
export type MergewiseReviewConfig = MergewiseReviewConfigV1;

/**
 * Backward-compatible alias for the v1 LLM config shape.
 */
export type MergewiseLlmConfig = MergewiseLlmConfigV1;

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
    maxComments: 5,
  },
  rules: {
    include: [],
    exclude: [],
  },
  review: {
    skipPatterns: [],
  },
  llm: {
    enabled: true,
    model: "gpt-4o",
    tokenBudget: 30_000,
    baseUrl: "https://api.openai.com/v1",
    consistencySamples: 1,
    triageModel: "gpt-4o-mini",
    criticModel: "gpt-4o-mini",
  },
};

interface RawMergewiseConfig {
  gating?: {
    confidenceThreshold?: unknown;
    maxComments?: unknown;
  };
  rules?: {
    include?: unknown;
    exclude?: unknown;
  };
  review?: {
    skipPatterns?: unknown;
  };
  llm?: {
    enabled?: unknown;
    model?: unknown;
    tokenBudget?: unknown;
    baseUrl?: unknown;
    consistencySamples?: unknown;
    triageModel?: unknown;
    criticModel?: unknown;
  };
}

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
    review: {
      skipPatterns: [...DEFAULT_MERGEWISE_CONFIG.review.skipPatterns],
    },
    llm: { ...DEFAULT_MERGEWISE_CONFIG.llm },
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

    return entry.trim();
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
  const hasConfidenceThreshold = confidenceThreshold !== undefined;
  if (hasConfidenceThreshold && (typeof confidenceThreshold !== "number" || Number.isNaN(confidenceThreshold))) {
    throw new MergewiseConfigValidationError(filePath, "gating.confidenceThreshold must be a number");
  }
  if (hasConfidenceThreshold && (confidenceThreshold < 0 || confidenceThreshold > 1)) {
    throw new MergewiseConfigValidationError(
      filePath,
      "gating.confidenceThreshold must be between 0 and 1",
    );
  }
  if (hasConfidenceThreshold) {
    normalizedConfig.gating.confidenceThreshold = confidenceThreshold;
  }

  const maxComments = rawConfig.gating.maxComments;
  const hasMaxComments = maxComments !== undefined;
  if (
    hasMaxComments &&
    (typeof maxComments !== "number" || !Number.isInteger(maxComments) || maxComments < 1)
  ) {
    throw new MergewiseConfigValidationError(
      filePath,
      "gating.maxComments must be an integer greater than or equal to 1",
    );
  }
  if (hasMaxComments) {
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

function applyReview(
  rawConfig: RawMergewiseConfig,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  if (rawConfig.review === undefined) {
    return;
  }

  if (!isPlainObject(rawConfig.review)) {
    throw new MergewiseConfigValidationError(filePath, "review must be an object");
  }

  const skipPatterns = rawConfig.review.skipPatterns;
  const hasSkipPatterns = skipPatterns !== undefined;
  if (hasSkipPatterns && !Array.isArray(skipPatterns)) {
    throw new MergewiseConfigValidationError(filePath, "review.skipPatterns must be an array of strings");
  }
  if (hasSkipPatterns) {
    const patterns = skipPatterns as unknown[];
    for (let index = 0; index < patterns.length; index++) {
      const entry = patterns[index];
      if (typeof entry !== "string" || !entry.trim()) {
        throw new MergewiseConfigValidationError(
          filePath,
          `review.skipPatterns[${index}] must be a non-empty string`,
        );
      }
    }
    normalizedConfig.review.skipPatterns = (patterns as string[]).map((entry) => entry.trim());
  }
}

function applyLlmCoreFields(
  rawLlm: NonNullable<RawMergewiseConfig["llm"]>,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  const enabled = rawLlm.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new MergewiseConfigValidationError(filePath, "llm.enabled must be a boolean");
  }
  if (enabled !== undefined) normalizedConfig.llm.enabled = enabled;

  const model = rawLlm.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw new MergewiseConfigValidationError(filePath, "llm.model must be a non-empty string");
  }
  if (typeof model === "string") normalizedConfig.llm.model = model.trim();

  const tokenBudget = rawLlm.tokenBudget;
  if (tokenBudget !== undefined && (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget < 1000)) {
    throw new MergewiseConfigValidationError(filePath, "llm.tokenBudget must be an integer greater than or equal to 1000");
  }
  if (typeof tokenBudget === "number") normalizedConfig.llm.tokenBudget = tokenBudget;

  const baseUrl = rawLlm.baseUrl;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || !baseUrl.trim())) {
    throw new MergewiseConfigValidationError(filePath, "llm.baseUrl must be a non-empty string");
  }
  if (typeof baseUrl === "string") normalizedConfig.llm.baseUrl = baseUrl.trim();
}

function applyLlmModelFields(
  rawLlm: NonNullable<RawMergewiseConfig["llm"]>,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  const consistencySamples = rawLlm.consistencySamples;
  if (consistencySamples !== undefined && (typeof consistencySamples !== "number" || !Number.isInteger(consistencySamples) || consistencySamples < 1 || consistencySamples > 10)) {
    throw new MergewiseConfigValidationError(filePath, "llm.consistencySamples must be an integer between 1 and 10");
  }
  if (typeof consistencySamples === "number") normalizedConfig.llm.consistencySamples = consistencySamples;

  const triageModel = rawLlm.triageModel;
  if (triageModel !== undefined && (typeof triageModel !== "string" || !triageModel.trim())) {
    throw new MergewiseConfigValidationError(filePath, "llm.triageModel must be a non-empty string");
  }
  if (typeof triageModel === "string") normalizedConfig.llm.triageModel = triageModel.trim();

  const criticModel = rawLlm.criticModel;
  if (criticModel !== undefined && (typeof criticModel !== "string" || !criticModel.trim())) {
    throw new MergewiseConfigValidationError(filePath, "llm.criticModel must be a non-empty string");
  }
  if (typeof criticModel === "string") normalizedConfig.llm.criticModel = criticModel.trim();
}

function applyLlm(
  rawConfig: RawMergewiseConfig,
  normalizedConfig: MergewiseConfig,
  filePath: string,
): void {
  if (rawConfig.llm === undefined) return;

  if (!isPlainObject(rawConfig.llm)) {
    throw new MergewiseConfigValidationError(filePath, "llm must be an object");
  }

  applyLlmCoreFields(rawConfig.llm, normalizedConfig, filePath);
  applyLlmModelFields(rawConfig.llm, normalizedConfig, filePath);
}

function parseRawConfig(filePath: string): unknown {
  let rawYaml: string;
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
  applyReview(rawConfig, normalizedConfig, filePath);
  applyLlm(rawConfig, normalizedConfig, filePath);

  return normalizedConfig;
}

/**
 * Loads and validates `.mergewise.yml` from disk.
 *
 * @remarks
 * When the config file does not exist, defaults are returned.
 * Rule identifiers in `rules.include` and `rules.exclude` are normalized by
 * trimming surrounding whitespace.
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
