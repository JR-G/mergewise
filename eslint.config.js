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
        project: "./tsconfig.json",
      },
    },
    plugins: {
      tsdoc,
      "@typescript-eslint": tseslint,
    },
    rules: {
      "tsdoc/syntax": "error",
      "id-length": [
        "error",
        { "min": 2, "exceptions": ["_", "$"], "properties": "never" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": [
        "error",
        { "ignoreVoid": false, "ignoreIIFE": false },
      ],
      "no-warning-comments": [
        "warn",
        { "terms": ["todo", "fixme", "xxx"], "location": "anywhere" },
      ],
      "no-restricted-imports": [
        "error",
        {
          "patterns": [
            {
              "group": ["**/packages/*", "../**/packages/*", "**/apps/*", "../**/apps/*"],
              "message": "Use workspace aliases (for example @mergewise/shared-types) for cross-package imports."
            }
          ]
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
];
