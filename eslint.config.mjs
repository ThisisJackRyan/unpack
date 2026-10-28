import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import noRawErrorLog from "./scripts/lint/no-raw-error-log.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // A caught error reaches a log call only through safeErrorFields(...)
  // (scripts/lint/no-raw-error-log.mjs). All of src: server and client
  // files, the proxy, src/db, and the tests.
  {
    files: ["src/**/*.{ts,tsx,js,mjs}"],
    plugins: { unpack: { rules: { "no-raw-error-log": noRawErrorLog } } },
    rules: { "unpack/no-raw-error-log": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
