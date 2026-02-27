import { describe, expect, test } from "bun:test";

import { buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
  test("does not contain the problematic structural suggestion rewrite clause", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("extracted function signatures or the refactored shape");
  });

  test("instructs against suggestedRewrite for structural suggestions", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Never provide suggestedRewrite for structural suggestions");
  });
});
