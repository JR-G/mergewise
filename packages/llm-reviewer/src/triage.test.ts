import { describe, expect, test } from "bun:test";
import { parseTriageResponse } from "./triage";

const FILE_PATHS = ["src/index.ts", "src/utils.ts", "src/config.ts"];

describe("parseTriageResponse", () => {
  test("parses valid JSON response into TriageResult array", () => {
    const raw = JSON.stringify({
      files: [
        { filePath: "src/index.ts", classifications: ["god-function-growth"], priority: "high", reasoning: "Large function added" },
        { filePath: "src/utils.ts", classifications: ["naming-issues"], priority: "low", reasoning: "Minor rename" },
        { filePath: "src/config.ts", classifications: [], priority: "skip", reasoning: "Config only" },
      ],
    });

    const results = parseTriageResponse(raw, FILE_PATHS);

    expect(results.length).toBe(3);
    expect(results.some((result) => result.filePath === "src/index.ts" && result.priority === "high")).toBe(true);
    expect(results.some((result) => result.filePath === "src/config.ts" && result.priority === "skip")).toBe(true);
  });

  test("defaults missing files to medium priority", () => {
    const raw = JSON.stringify({
      files: [
        { filePath: "src/index.ts", classifications: ["error-handling"], priority: "high", reasoning: "Error paths" },
      ],
    });

    const results = parseTriageResponse(raw, FILE_PATHS);
    const utilsResult = results.find((result) => result.filePath === "src/utils.ts");

    expect(utilsResult).toBeDefined();
    expect(utilsResult!.priority).toBe("medium");
    expect(utilsResult!.reasoning).toBe("Not classified by triage");
  });

  test("caps classifications at 5 per file", () => {
    const raw = JSON.stringify({
      files: [
        {
          filePath: "src/index.ts",
          classifications: ["a", "b", "c", "d", "e", "f", "g"],
          priority: "high",
          reasoning: "Many concerns",
        },
      ],
    });

    const results = parseTriageResponse(raw, ["src/index.ts"]);
    expect(results[0]!.classifications.length).toBe(5);
  });

  test("returns all files as high when JSON is invalid", () => {
    const results = parseTriageResponse("not json{{{", FILE_PATHS);

    expect(results.length).toBe(3);
    for (const result of results) {
      expect(result.priority).toBe("high");
      expect(result.reasoning).toContain("not valid JSON");
    }
  });

  test("returns empty array for empty file list", () => {
    const results = parseTriageResponse(JSON.stringify({ files: [] }), []);
    expect(results).toEqual([]);
  });

  test("normalises invalid priority to medium", () => {
    const raw = JSON.stringify({
      files: [
        { filePath: "src/index.ts", classifications: [], priority: "URGENT", reasoning: "Test" },
      ],
    });

    const results = parseTriageResponse(raw, ["src/index.ts"]);
    expect(results[0]!.priority).toBe("medium");
  });

  test("handles missing fields gracefully", () => {
    const raw = JSON.stringify({
      files: [{ filePath: "src/index.ts" }],
    });

    const results = parseTriageResponse(raw, ["src/index.ts"]);
    expect(results[0]!.classifications).toEqual([]);
    expect(results[0]!.priority).toBe("medium");
    expect(results[0]!.reasoning).toBe("Not classified");
  });

  test("filters non-string classifications", () => {
    const raw = JSON.stringify({
      files: [
        { filePath: "src/index.ts", classifications: ["valid", 42, null, "also-valid"], priority: "high", reasoning: "Mixed" },
      ],
    });

    const results = parseTriageResponse(raw, ["src/index.ts"]);
    expect(results[0]!.classifications).toEqual(["valid", "also-valid"]);
  });

  test("handles response with files array not matching input paths", () => {
    const raw = JSON.stringify({
      files: [
        { filePath: "src/unknown.ts", classifications: ["error-handling"], priority: "high", reasoning: "Unknown file" },
      ],
    });

    const results = parseTriageResponse(raw, FILE_PATHS);
    for (const result of results) {
      expect(result.priority).toBe("medium");
    }
  });
});
