import { describe, expect, test } from "bun:test";

import { buildSystemPrompt } from "./prompt";

describe("buildSystemPrompt", () => {
  test("does not contain the problematic structural suggestion rewrite clause", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("extracted function signatures or the refactored shape");
  });

  test("constrains suggestedRewrite to localised fixes and excludes structural rewrites", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("drop-in fix");
    expect(prompt).toContain("structural suggestions");
    expect(prompt).toContain("recommendation field");
  });

  test("scopes React-specific suggestions to React files only", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("only apply to .tsx/.jsx files");
    expect(prompt).toContain("Never suggest React APIs");
  });

  test("instructs LLM to never flag comment or documentation lines", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Comment and documentation lines");
    expect(prompt).toContain("Never flag TSDoc");
    expect(prompt).toContain("not a code issue");
  });
});
