import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "warehouse-agent/**",
  ]),
  {
    rules: {
      // TODO(refactor): migrate data-loading effects (page-level fetch-in-effect)
      // and derived state patterns (conditional setState in effect) off useEffect,
      // then restore this rule to "error". Tracked as: "Refactor React 19
      // set-state-in-effect violations" — split into (a) data-loading pages and
      // (b) derived state in components.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
