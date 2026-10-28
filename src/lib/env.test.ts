import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isProduction } from "./env";

const SRC = new URL("../", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("isProduction", () => {
  it("is true for NODE_ENV=production or VERCEL_ENV=production", () => {
    assert.equal(isProduction({ NODE_ENV: "production" }), true);
    assert.equal(isProduction({ VERCEL_ENV: "production" }), true);
    assert.equal(isProduction({ NODE_ENV: "development", VERCEL_ENV: "production" }), true);
    // Vercel builds previews with NODE_ENV=production.
    assert.equal(isProduction({ NODE_ENV: "production", VERCEL_ENV: "preview" }), true);
  });

  it("is false otherwise", () => {
    assert.equal(isProduction({}), false);
    assert.equal(isProduction({ NODE_ENV: "development" }), false);
    assert.equal(isProduction({ NODE_ENV: "test" }), false);
    assert.equal(isProduction({ NODE_ENV: "development", VERCEL_ENV: "preview" }), false);
    assert.equal(isProduction({ NODE_ENV: "Production" }), false);
  });

  it("reads process.env by default", () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    const env = process.env as Record<string, string | undefined>;
    try {
      env.NODE_ENV = "development";
      delete env.VERCEL_ENV;
      assert.equal(isProduction(), false);
      env.VERCEL_ENV = "production";
      assert.equal(isProduction(), true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  });
});

describe("production gating goes through isProduction", () => {
  it("no other app file compares NODE_ENV or VERCEL_ENV to production", () => {
    const offenders = sourceFiles(SRC).filter((path) => {
      if (path.endsWith("/lib/env.ts")) return false;
      const text = readFileSync(path, "utf8");
      return /NODE_ENV\s*[!=]==?\s*["']production["']|VERCEL_ENV\s*[!=]==?/.test(text);
    });
    assert.deepEqual(offenders, []);
  });

  it("the production gates import it", () => {
    for (const file of ["lib/client-ip.ts", "lib/join-bot-check.ts", "lib/student-session.ts"]) {
      const text = readFileSync(join(SRC, file), "utf8");
      assert.match(text, /import \{ isProduction[^}]*\} from "\.\/env"/, file);
      assert.match(text, /isProduction\(/, file);
    }
  });
});
