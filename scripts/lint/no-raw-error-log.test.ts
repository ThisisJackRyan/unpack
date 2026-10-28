import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ESLint, RuleTester } from "eslint";
import rule from "./no-raw-error-log.mjs";

// RuleTester runs its cases through node:test.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: "latest", sourceType: "module" } });
const raw = (count = 1) => Array.from({ length: count }, () => ({ messageId: "raw" }));

tester.run("no-raw-error-log", rule, {
  valid: [
    `try { f(); } catch (error) { console.error("save failed", safeErrorFields(error)); }`,
    `try { f(); } catch (e) { console.error("x", { ...safeErrorFields(e), readingId }); }`,
    `try { f(); } catch (e) { logError("x", safeErrorFields(e), id); }`,
    `try { f(); } catch (e) { deps.log("x", { kind: e instanceof FetchArticleError ? e.kind : "http_error" }); }`,
    `try { f(); } catch (e) { console.error("x", { code: e.code, name: e.name, status: e.status }); }`,
    `try { f(); } catch (e) { const kind = questionErrorKind(e); console.error("x", { kind }); }`,
    `function g() { try { f(); } catch (e) { if (isNotFound(e)) return null; throw e; } }`,
    `try { f(); } catch (e) { console.error("x", { kind: e.kind }); }`,
    `try { f(); } catch { console.error("failed"); }`,
    `try { f(); } catch (e) { report(e); }`,
    `try { f(); } catch (e) { const { kind } = e; console.error(kind); }`,
    // Not a caught error: a parameter (the runtime wrapper covers these).
    `function onError(error) { console.error(error); }`,
  ],
  invalid: [
    { code: `try { f(); } catch (e) { console.error(e); }`, errors: raw() },
    { code: `try { f(); } catch (err) { console.warn("x", err); }`, errors: raw() },
    { code: `try { f(); } catch (whatever) { console.log("a", 1, whatever); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(e.message); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", e.stack); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", e.cause); }`, errors: raw() },
    { code: "try { f(); } catch (e) { console.error(`failed: ${e}`); }", errors: raw() },
    { code: "try { f(); } catch (e) { console.error(`failed: ${e.message.slice(0, 80)}`); }", errors: raw() },
    { code: `try { f(); } catch (e) { console.error("failed: " + e); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(String(e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(JSON.stringify(e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(util.inspect(e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(e.toString()); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", { e }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", { error: e, readingId }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", { ...e }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", [e]); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", { nested: { error: e } }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", ok ? e : null); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error("x", e ?? "none"); }`, errors: raw() },
    { code: `try { f(); } catch (e) { logError("x", e, id); }`, errors: raw() },
    { code: `try { f(); } catch (e) { logDbError("x", e); }`, errors: raw() },
    { code: `try { f(); } catch (e) { deps.log("x", { error: e }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { this.logger("x", e); }`, errors: raw() },
    // Derived through variables and destructuring.
    { code: `try { f(); } catch (e) { const m = e.message; console.error(m); }`, errors: raw() },
    { code: `try { f(); } catch (e) { const { message } = e; console.error(message); }`, errors: raw() },
    { code: `try { f(); } catch ({ message }) { console.error(message); }`, errors: raw() },
    { code: `try { f(); } catch (e) { const copy = e; const text = String(copy); console.error(text); }`, errors: raw() },
    { code: `let last; try { f(); } catch (e) { last = e; } console.error(last);`, errors: raw() },
    // In a callback inside the catch.
    { code: `try { f(); } catch (e) { setTimeout(() => console.error(e)); }`, errors: raw() },
    // Two separate leaks, two reports.
    { code: `try { f(); } catch (e) { console.error(e); console.warn(e.message); }`, errors: raw(2) },
  ],
});

// The rule as the repo's ESLint config applies it: TypeScript, and every
// part of src (the proxy, src/db, a client component).
describe("eslint.config.mjs applies unpack/no-raw-error-log to all of src", () => {
  const eslint = new ESLint({ cwd: new URL("../../", import.meta.url).pathname });
  const LEAK = `export async function load(): Promise<void> {
  try {
    await Promise.resolve();
  } catch (error: unknown) {
    console.error("load failed", (error as Error).message);
  }
}
`;

  for (const filePath of ["src/proxy.ts", "src/db/fixture.ts", "src/lib/fixture.ts", "src/app/fixture/actions.ts"]) {
    it(`fires in ${filePath}`, async () => {
      const [result] = await eslint.lintText(LEAK, { filePath });
      assert.deepEqual(
        result.messages.filter((m) => m.ruleId === "unpack/no-raw-error-log").map((m) => m.line),
        [5],
      );
    });
  }

  it("fires in a client component", async () => {
    const code = `"use client";
export function Button() {
  const onClick = () => {
    try {
      JSON.parse("x");
    } catch (e) {
      console.error({ e });
    }
  };
  return <button onClick={onClick}>Go</button>;
}
`;
    const [result] = await eslint.lintText(code, { filePath: "src/components/fixture-button.tsx" });
    assert.equal(result.messages.filter((m) => m.ruleId === "unpack/no-raw-error-log").length, 1);
  });

  it("is quiet for the safe form", async () => {
    const code = LEAK.replace("(error as Error).message", "safeErrorFields(error)").replace(
      "export async",
      'import { safeErrorFields } from "@/lib/safe-error-fields";\nexport async',
    );
    const [result] = await eslint.lintText(code, { filePath: "src/lib/fixture.ts" });
    assert.deepEqual(result.messages.filter((m) => m.ruleId === "unpack/no-raw-error-log"), []);
  });
});
