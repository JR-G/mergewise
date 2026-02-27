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

  test("instructs LLM to never flag non-code content", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Non-code content");
    expect(prompt).toContain("string literals");
    expect(prompt).toContain("not a code issue");
  });

  test("includes switch-on-type pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("switch-on-type");
    expect(prompt).toContain(
      "switch or if-else chain with 4+ branches dispatching on a .type, .kind, or string-literal discriminator",
    );
  });

  test("includes manual-object-construction pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("manual-object-construction");
    expect(prompt).toContain(
      "3+ object literals with the same set of keys constructed in the same scope",
    );
  });

  test("includes scattered-event-handling pattern in the default prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("scattered-event-handling");
    expect(prompt).toContain(
      ".on(), .addEventListener(), or .subscribe() calls on the same target scattered across a function body",
    );
  });
});
