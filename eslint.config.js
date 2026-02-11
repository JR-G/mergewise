import tsdoc from "eslint-plugin-tsdoc";
import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".mergewise-runtime/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      tsdoc,
      "@typescript-eslint": tseslint,
    },
    rules: {
      "tsdoc/syntax": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-warning-comments": [
        "warn",
        { "terms": ["todo", "fixme", "xxx"], "location": "anywhere" },
      ],
      "no-restricted-imports": [
        "error",
        {
          "patterns": [
            {
              "group": ["../../../packages/*", "../../packages/*", "../packages/*"],
              "message": "Use workspace aliases (for example @mergewise/shared-types) for cross-package imports."
            }
          ]
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
];
