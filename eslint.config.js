import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import tsdoc from "eslint-plugin-tsdoc";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".mergewise-runtime/**",
      "**/*.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs["flat/strict-type-checked"],
  ...tseslint.configs["flat/stylistic-type-checked"],
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
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
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-deprecated": "off",
    },
  },
];
