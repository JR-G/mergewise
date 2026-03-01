import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import tsdoc from "eslint-plugin-tsdoc";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".mergewise-runtime/**",
      "packages/eval/fixtures/**",
      "**/*.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: { tsdoc },
    rules: {
      "tsdoc/syntax": "error",
      "id-length": [
        "error",
        { min: 2, exceptions: ["_", "$"], properties: "never" },
      ],
      "no-warning-comments": [
        "warn",
        { terms: ["todo", "fixme", "xxx"], location: "anywhere" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "IfStatement > IfStatement.consequent, IfStatement > BlockStatement.consequent > IfStatement",
          message:
            "Nested if statements are not allowed. Prefer guard clauses or early returns.",
        },
        {
          selector:
            "IfStatement > IfStatement.alternate[alternate.type='IfStatement']",
          message:
            "More than one else-if branch detected. Prefer a switch statement when branching on one value.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/packages/*",
                "../**/packages/*",
                "**/apps/*",
                "../**/apps/*",
              ],
              message: "Use workspace aliases.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, ignoreIIFE: false },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "max-lines-per-function": [
        "error",
        { max: 75, skipBlankLines: true, skipComments: true },
      ],
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: true, skipComments: true },
      ],
      "max-params": ["error", { max: 4 }],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/unbound-method": "off",
      "max-lines-per-function": "off",
      "max-lines": "off",
    },
  },
  {
    files: [
      "apps/worker/src/main.ts",
      "apps/webhook-api/src/main.ts",
      "packages/llm-reviewer/src/signals.ts",
    ],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-params": "off",
    },
  },
];
