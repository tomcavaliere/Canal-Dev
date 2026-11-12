// ESLint (configuration « plate ») : `npm run lint`, exécuté aussi par la CI.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "js/sdk/"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.browser },
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: globals.serviceworker },
  },
  {
    files: ["redirect.js", "js/redirect.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["tests/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: globals.node },
  },
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
];
