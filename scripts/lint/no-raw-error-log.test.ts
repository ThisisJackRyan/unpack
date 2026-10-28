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
    // Promise handlers and callbacks, through the safe helper.
    `p.catch((e) => console.error("x", safeErrorFields(e)));`,
    `p.then((value) => console.log(value), (err) => logError("x", safeErrorFields(err)));`,
    `p.then((value) => console.log(value));`,
    `run({ onError: (error) => console.error("x", safeErrorFields(error)) });`,
    `run({ onFailure(error) { console.error("x", { kind: error.kind }); } });`,
    // This repo's deps pass safe fields to callbacks named so.
    `run({ onError: (fields) => logModelError("x", { ...fields, readingId }) });`,
    `run({ onFailure: (refusalFields) => console.error("x", refusalFields) });`,
    `process.on("uncaughtException", (err) => console.error("x", safeErrorFields(err)));`,
    `emitter.on("data", (chunk) => console.log(chunk));`,
    // A local helper that makes it safe, or reads a safe field.
    `function fields(error) { return { ...safeErrorFields(error), status: statusOf(error) }; }
     function statusOf(error) { const { status } = error ?? {}; return typeof status === "number" ? status : undefined; }
     try { f(); } catch (e) { console.error("x", fields(e)); }`,
    `const kindOf = (error) => error.kind; try { f(); } catch (e) { console.error(kindOf(e)); }`,
    // Returned, then only a safe field read from the result.
    `function attempt() { try { return { ok: true }; } catch (e) { return { ok: false, error: e }; } }
     const r = attempt(); console.error("x", { ok: r.ok, status: r.error?.status, fields: safeErrorFields(r.error) });`,
    // An aliased console with a safe value, and a write of fixed text.
    `const log = console.error; try { f(); } catch (e) { log("x", safeErrorFields(e)); }`,
    `try { f(); } catch (e) { process.stderr.write("failed\\n"); }`,
    `try { f(); } catch (e) { throw new Error("wrapped", { cause: e }); }`,
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
    // Promise rejection handlers.
    { code: `p.catch((e) => console.error(e));`, errors: raw() },
    { code: `p.catch(function (reason) { console.warn("x", reason.message); });`, errors: raw() },
    { code: `p.then(undefined, (err) => console.error("x", { err }));`, errors: raw() },
    { code: `p.then(ok, (err) => logError("x", String(err)));`, errors: raw() },
    { code: `const r = await p.catch((e) => e); console.error(r);`, errors: raw() },
    // onError and onFailure callbacks, as properties, methods, and JSX.
    { code: `run({ onError: (error) => console.error("x", error) });`, errors: raw() },
    { code: `run({ onFailure(e) { console.error(e.stack); } });`, errors: raw() },
    { code: `run({ onError: (fields, extra) => console.error(fields), onFailure: (cause) => console.error(cause) });`, errors: raw() },
    { code: `<Script onError={(e) => console.error(e)} />`, errors: raw(), languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
    // Error event listeners.
    { code: `process.on("unhandledRejection", (reason) => console.error(reason));`, errors: raw() },
    { code: `window.addEventListener("error", (event) => console.error(event));`, errors: raw() },
    // Closures and local helpers.
    { code: `try { f(); } catch (e) { const get = () => e; console.error(get()); }`, errors: raw() },
    { code: `function same(x) { return x; } try { f(); } catch (e) { console.error(same(e)); }`, errors: raw() },
    { code: `const same = (x) => x; try { f(); } catch (e) { console.error("x", { error: same(e) }); }`, errors: raw() },
    { code: `function report(err) { console.error("failed", err); } try { f(); } catch (e) { report(e); }`, errors: raw() },
    { code: `const report = (where, err) => console.error(where, err.message); try { f(); } catch (e) { report("x", e); }`, errors: raw() },
    {
      code: `function outer(err) { return inner(err); } function inner(x) { return { x }; } try { f(); } catch (e) { console.error(outer(e)); }`,
      errors: raw(),
    },
    { code: `function attempt() { try { g(); } catch (e) { return e; } } console.error(attempt());`, errors: raw() },
    { code: `try { f(); } catch (e) { setTimeout(() => { const m = e.message; console.error(m); }); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(({ e }).e); }`, errors: raw() },
    // Aliased console and stdio sinks.
    { code: `const log = console.error; try { f(); } catch (e) { log(e); }`, errors: raw() },
    { code: `const c = console; try { f(); } catch (e) { c.warn("x", e); }`, errors: raw() },
    { code: `const { error } = console; try { f(); } catch (e) { error(e); }`, errors: raw() },
    { code: `const { error: shout } = console; try { f(); } catch (e) { shout(e.message); }`, errors: raw() },
    { code: `const say = console.log.bind(console); try { f(); } catch (e) { say(e); }`, errors: raw() },
    { code: `try { f(); } catch (e) { globalThis.console.error(e); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console["error"](e); }`, errors: raw() },
    { code: `try { f(); } catch (e) { process.stderr.write(String(e)); }`, errors: raw() },
    { code: "try { f(); } catch (e) { process.stdout.write(`${e.message}\\n`); }", errors: raw() },
    { code: `const out = process.stderr; try { f(); } catch (e) { out.write(e.stack); }`, errors: raw() },
    // Wrapped or copied.
    { code: `try { f(); } catch (e) { console.error(new Error("wrapped", { cause: e })); }`, errors: raw() },
    { code: `try { f(); } catch (e) { const w = new Error("wrapped", { cause: e }); console.error(w); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(Object.assign({}, e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { const copy = {}; Object.assign(copy, e); console.error(copy); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(structuredClone(e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(Object.entries(e)); }`, errors: raw() },
    { code: `try { f(); } catch (e) { const fields = { at: "x" }; fields.error = e; console.error(fields); }`, errors: raw() },
    { code: `const errors = []; try { f(); } catch (e) { errors.push(e); } console.error(errors);`, errors: raw() },
    { code: `try { f(); } catch (e) { console.error(new Map([["e", e]])); }`, errors: raw() },
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
