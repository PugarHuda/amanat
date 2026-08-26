// Flat config, ESLint 10. The rules here are the ones that catch mistakes, not
// the ones that argue about style — formatting is not what this repo gets wrong.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "onchain/lib/**", "onchain/out/**", "scorer/target/**", "test-results/**", "playwright-report/**"] },

  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,

      // An unused variable is either a leftover or a mistake about what a
      // function returns. Both are worth seeing; an underscore prefix says
      // "deliberately ignored".
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      // A promise nobody awaits fails silently, which is how a paid call goes
      // missing without anyone noticing.
      "no-async-promise-executor": "error",
      "require-atomic-updates": "error",

      // Control characters in a regex were a real bug here, twice.
      "no-control-regex": "error",
      "no-misleading-character-class": "error",

      // == against null is the one loose comparison worth keeping; everything
      // else hides a type surprise.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": ["error", { boolean: false }],
    },
  },

  {
    // The page's script runs in a browser, not in Node.
    files: ["test/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
