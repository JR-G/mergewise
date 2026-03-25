import { parseArgs } from "node:util";
import type { ReviewClientConfig } from "@mergewise/llm-reviewer";
import type { EvalResult, EvalVariant } from "./types";
import { discoverFixtures, loadFixture } from "./loader";
import { runFixture } from "./runner";
import { printReport, printMultiRunReport, appendRunRecord } from "./reporter";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    fixture: { type: "string" },
    variant: { type: "string" },
    runs: { type: "string" },
    model: { type: "string" },
  },
  strict: true,
});

const runCount = values.runs ? parseInt(values.runs, 10) : 1;
if (!Number.isFinite(runCount) || runCount < 1) {
  console.error("--runs must be a positive integer");
  process.exit(1);
}

const apiKey = process.env["LLM_EVAL_API_KEY"];
if (!apiKey) {
  console.error("LLM_EVAL_API_KEY is required");
  process.exit(1);
}

const rawBaseUrl = process.env["LLM_EVAL_BASE_URL"]?.trim();
const baseUrl = rawBaseUrl !== undefined && rawBaseUrl.length > 0 ? rawBaseUrl : undefined;
const rawModel = process.env["LLM_EVAL_MODEL"]?.trim();
const envModel = rawModel !== undefined && rawModel.length > 0 ? rawModel : "gpt-4.1";

const modelArg = values.model?.trim();
const models = modelArg
  ? modelArg.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  : [envModel];

if (models.length === 0) {
  console.error("--model must specify at least one model name");
  process.exit(1);
}

function buildVariantsForModel(
  key: string,
  modelName: string,
  includeModelPrefix: boolean,
): EvalVariant[] {
  const clientConfig: ReviewClientConfig = { apiKey: key, baseUrl, model: modelName };
  const prefix = includeModelPrefix ? `${modelName}/` : "";
  return [
    { label: `${prefix}default`, clientConfig },
    { label: `${prefix}no-catalogue`, clientConfig, antiPatterns: [] },
  ];
}

const includeModelPrefix = models.length > 1;
const builtVariants = models.flatMap((modelName) => buildVariantsForModel(apiKey, modelName, includeModelPrefix));

const variantFilter = values.variant;
const variants = variantFilter
  ? builtVariants.filter((variant) => variant.label === variantFilter || variant.label.endsWith(`/${variantFilter}`))
  : builtVariants;

if (variants.length === 0) {
  console.error(`Unknown variant: ${variantFilter}`);
  process.exit(1);
}

const fixtureFilter = values.fixture;
const fixtureNames = fixtureFilter
  ? [fixtureFilter]
  : await discoverFixtures();

const allResults: EvalResult[][] = [];

for (let run = 0; run < runCount; run++) {
  if (runCount > 1) {
    console.log(`\n--- Run ${run + 1} of ${runCount} ---\n`);
  }

  const results: EvalResult[] = [];

  for (const fixtureName of fixtureNames) {
    let fixture;
    try {
      fixture = await loadFixture(fixtureName);
    } catch (error) {
      console.error(`Failed to load fixture "${fixtureName}":`, error);
      continue;
    }

    for (const variant of variants) {
      console.log(`Running ${fixtureName} / ${variant.label}...`);
      try {
        const result = await runFixture(fixture, variant);
        results.push(result);
      } catch (error) {
        console.error(
          `Failed to run fixture "${fixtureName}" variant "${variant.label}":`,
          error,
        );
      }
    }
  }

  allResults.push(results);
}

if (runCount > 1) {
  printMultiRunReport(allResults);
} else if (allResults[0]) {
  printReport(allResults[0]);
}

const failedAppends: number[] = [];

for (let runIndex = 0; runIndex < allResults.length; runIndex++) {
  try {
    const results = allResults[runIndex];
    if (!results) continue;
    await appendRunRecord(results);
  } catch (error) {
    console.error(`Failed to write run record for run ${runIndex + 1}:`, error);
    failedAppends.push(runIndex + 1);
  }
}

if (failedAppends.length === allResults.length) {
  console.error("All run records failed to write");
  process.exit(1);
} else if (failedAppends.length > 0) {
  console.error(`Failed to write ${failedAppends.length} of ${allResults.length} run records`);
} else {
  console.log("Results appended to packages/eval/results/runs.ndjson");
}
