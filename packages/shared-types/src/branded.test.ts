import { describe, expect, test } from "bun:test";
import {
  toFilePath,
  tryParseFilePath,
  toRepoFullName,
  tryParseRepoFullName,
  toSHA,
  tryParseSHA,
  toScanId,
  tryParseScanId,
  generateScanId,
  toJobId,
  tryParseJobId,
  generateJobId,
  toRuleId,
  tryParseRuleId,
  toConfidence,
  tryParseConfidence,
  toLineNumber,
  tryParseLineNumber,
  toPRNumber,
  tryParsePRNumber,
  toInstallationId,
  tryParseInstallationId,
} from "./branded";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_SHA = "a".repeat(40);

describe("FilePath", () => {
  test("accepts a valid relative path", () => {
    const result: string = toFilePath("src/index.ts");
    expect(result).toBe("src/index.ts");
  });

  test("rejects empty string", () => {
    expect(() => toFilePath("")).toThrow(TypeError);
  });

  test("rejects absolute path with leading slash", () => {
    expect(() => toFilePath("/usr/local/bin")).toThrow(TypeError);
  });

  test("tryParse returns null for empty string", () => {
    expect(tryParseFilePath("")).toBeNull();
  });

  test("tryParse returns null for absolute path", () => {
    expect(tryParseFilePath("/absolute")).toBeNull();
  });

  test("tryParse returns branded value for valid path", () => {
    const result: string | null = tryParseFilePath("src/index.ts");
    expect(result).toBe("src/index.ts");
  });
});

describe("RepoFullName", () => {
  test("accepts owner/repo format", () => {
    const result: string = toRepoFullName("acme/widget");
    expect(result).toBe("acme/widget");
  });

  test("rejects empty string", () => {
    expect(() => toRepoFullName("")).toThrow(TypeError);
  });

  test("rejects missing slash", () => {
    expect(() => toRepoFullName("acme-widget")).toThrow(TypeError);
  });

  test("rejects multiple slashes", () => {
    expect(() => toRepoFullName("acme/widget/extra")).toThrow(TypeError);
  });

  test("rejects empty owner segment", () => {
    expect(() => toRepoFullName("/widget")).toThrow(TypeError);
  });

  test("rejects empty repo segment", () => {
    expect(() => toRepoFullName("acme/")).toThrow(TypeError);
  });

  test("tryParse returns null for invalid format", () => {
    expect(tryParseRepoFullName("no-slash")).toBeNull();
  });

  test("tryParse returns branded value for valid format", () => {
    const result: string | null = tryParseRepoFullName("acme/widget");
    expect(result).toBe("acme/widget");
  });
});

describe("SHA", () => {
  test("accepts 40 lowercase hex characters", () => {
    const result: string = toSHA(VALID_SHA);
    expect(result).toBe(VALID_SHA);
  });

  test("rejects empty string", () => {
    expect(() => toSHA("")).toThrow(TypeError);
  });

  test("rejects short hex string", () => {
    expect(() => toSHA("abc123")).toThrow(TypeError);
  });

  test("rejects 39-character hex string", () => {
    expect(() => toSHA("a".repeat(39))).toThrow(TypeError);
  });

  test("rejects 41-character hex string", () => {
    expect(() => toSHA("a".repeat(41))).toThrow(TypeError);
  });

  test("rejects uppercase hex characters", () => {
    expect(() => toSHA("A".repeat(40))).toThrow(TypeError);
  });

  test("rejects non-hex characters", () => {
    expect(() => toSHA("g".repeat(40))).toThrow(TypeError);
  });

  test("tryParse returns null for invalid SHA", () => {
    expect(tryParseSHA("abc123")).toBeNull();
  });

  test("tryParse returns branded value for valid SHA", () => {
    const result: string | null = tryParseSHA(VALID_SHA);
    expect(result).toBe(VALID_SHA);
  });
});

describe("ScanId", () => {
  test("accepts valid UUID", () => {
    const result: string = toScanId(VALID_UUID);
    expect(result).toBe(VALID_UUID);
  });

  test("rejects empty string", () => {
    expect(() => toScanId("")).toThrow(TypeError);
  });

  test("rejects non-UUID string", () => {
    expect(() => toScanId("not-a-uuid")).toThrow(TypeError);
  });

  test("tryParse returns null for invalid UUID", () => {
    expect(tryParseScanId("bad")).toBeNull();
  });

  test("tryParse returns branded value for valid UUID", () => {
    const result: string | null = tryParseScanId(VALID_UUID);
    expect(result).toBe(VALID_UUID);
  });

  test("generateScanId produces valid UUID", () => {
    const scanId = generateScanId();
    expect(() => toScanId(scanId)).not.toThrow();
  });
});

describe("JobId", () => {
  test("accepts valid UUID", () => {
    const result: string = toJobId(VALID_UUID);
    expect(result).toBe(VALID_UUID);
  });

  test("rejects empty string", () => {
    expect(() => toJobId("")).toThrow(TypeError);
  });

  test("rejects non-UUID string", () => {
    expect(() => toJobId("not-a-uuid")).toThrow(TypeError);
  });

  test("tryParse returns null for invalid UUID", () => {
    expect(tryParseJobId("bad")).toBeNull();
  });

  test("tryParse returns branded value for valid UUID", () => {
    const result: string | null = tryParseJobId(VALID_UUID);
    expect(result).toBe(VALID_UUID);
  });

  test("generateJobId produces valid UUID", () => {
    const jobId = generateJobId();
    expect(() => toJobId(jobId)).not.toThrow();
  });
});

describe("RuleId", () => {
  test("accepts namespace/name format", () => {
    const result: string = toRuleId("ts-react/god-function");
    expect(result).toBe("ts-react/god-function");
  });

  test("accepts dots and underscores", () => {
    const result: string = toRuleId("ts.react/my_rule");
    expect(result).toBe("ts.react/my_rule");
  });

  test("accepts llm/reviewer", () => {
    const result: string = toRuleId("llm/reviewer");
    expect(result).toBe("llm/reviewer");
  });

  test("rejects empty string", () => {
    expect(() => toRuleId("")).toThrow(TypeError);
  });

  test("rejects missing slash", () => {
    expect(() => toRuleId("god-function")).toThrow(TypeError);
  });

  test("rejects uppercase characters", () => {
    expect(() => toRuleId("TS-React/rule")).toThrow(TypeError);
  });

  test("rejects multiple slashes", () => {
    expect(() => toRuleId("ts/react/rule")).toThrow(TypeError);
  });

  test("tryParse returns null for invalid format", () => {
    expect(tryParseRuleId("bad")).toBeNull();
  });

  test("tryParse returns branded value for valid format", () => {
    const result: string | null = tryParseRuleId("llm/reviewer");
    expect(result).toBe("llm/reviewer");
  });
});

describe("Confidence", () => {
  test("accepts 0", () => {
    const result: number = toConfidence(0);
    expect(result).toBe(0);
  });

  test("accepts 1", () => {
    const result: number = toConfidence(1);
    expect(result).toBe(1);
  });

  test("accepts 0.5", () => {
    const result: number = toConfidence(0.5);
    expect(result).toBe(0.5);
  });

  test("rejects negative values", () => {
    expect(() => toConfidence(-0.1)).toThrow(TypeError);
  });

  test("rejects values above 1", () => {
    expect(() => toConfidence(1.001)).toThrow(TypeError);
  });

  test("rejects NaN", () => {
    expect(() => toConfidence(NaN)).toThrow(TypeError);
  });

  test("rejects Infinity", () => {
    expect(() => toConfidence(Infinity)).toThrow(TypeError);
  });

  test("rejects negative Infinity", () => {
    expect(() => toConfidence(-Infinity)).toThrow(TypeError);
  });

  test("tryParse returns null for NaN", () => {
    expect(tryParseConfidence(NaN)).toBeNull();
  });

  test("tryParse returns null for out-of-range", () => {
    expect(tryParseConfidence(2)).toBeNull();
  });

  test("tryParse returns branded value for valid score", () => {
    const result: number | null = tryParseConfidence(0.85);
    expect(result).toBe(0.85);
  });
});

describe("LineNumber", () => {
  test("accepts positive integer", () => {
    const result: number = toLineNumber(1);
    expect(result).toBe(1);
  });

  test("accepts large positive integer", () => {
    const result: number = toLineNumber(999999);
    expect(result).toBe(999999);
  });

  test("rejects zero", () => {
    expect(() => toLineNumber(0)).toThrow(TypeError);
  });

  test("rejects negative integer", () => {
    expect(() => toLineNumber(-1)).toThrow(TypeError);
  });

  test("rejects float", () => {
    expect(() => toLineNumber(1.5)).toThrow(TypeError);
  });

  test("rejects NaN", () => {
    expect(() => toLineNumber(NaN)).toThrow(TypeError);
  });

  test("tryParse returns null for zero", () => {
    expect(tryParseLineNumber(0)).toBeNull();
  });

  test("tryParse returns null for negative", () => {
    expect(tryParseLineNumber(-5)).toBeNull();
  });

  test("tryParse returns branded value for valid line", () => {
    const result: number | null = tryParseLineNumber(42);
    expect(result).toBe(42);
  });
});

describe("PRNumber", () => {
  test("accepts positive integer", () => {
    const result: number = toPRNumber(1);
    expect(result).toBe(1);
  });

  test("accepts large positive integer", () => {
    const result: number = toPRNumber(99999);
    expect(result).toBe(99999);
  });

  test("rejects zero", () => {
    expect(() => toPRNumber(0)).toThrow(TypeError);
  });

  test("rejects negative integer", () => {
    expect(() => toPRNumber(-1)).toThrow(TypeError);
  });

  test("rejects float", () => {
    expect(() => toPRNumber(1.5)).toThrow(TypeError);
  });

  test("rejects NaN", () => {
    expect(() => toPRNumber(NaN)).toThrow(TypeError);
  });

  test("tryParse returns null for zero", () => {
    expect(tryParsePRNumber(0)).toBeNull();
  });

  test("tryParse returns branded value for valid number", () => {
    const result: number | null = tryParsePRNumber(42);
    expect(result).toBe(42);
  });
});

describe("InstallationId", () => {
  test("accepts positive integer", () => {
    const result: number = toInstallationId(12345);
    expect(result).toBe(12345);
  });

  test("rejects zero", () => {
    expect(() => toInstallationId(0)).toThrow(TypeError);
  });

  test("rejects negative integer", () => {
    expect(() => toInstallationId(-1)).toThrow(TypeError);
  });

  test("rejects float", () => {
    expect(() => toInstallationId(1.5)).toThrow(TypeError);
  });

  test("rejects NaN", () => {
    expect(() => toInstallationId(NaN)).toThrow(TypeError);
  });

  test("tryParse returns null for zero", () => {
    expect(tryParseInstallationId(0)).toBeNull();
  });

  test("tryParse returns null for negative", () => {
    expect(tryParseInstallationId(-1)).toBeNull();
  });

  test("tryParse returns branded value for valid id", () => {
    const result: number | null = tryParseInstallationId(12345);
    expect(result).toBe(12345);
  });
});
