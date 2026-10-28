import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// A server action's redirect() pushes by default, which would leave the
// filled-in form behind the new reading in history. Every redirect in the
// create action must say how it navigates (a replace, see
// createOutcomeRedirect in src/lib/self-allowance.ts).
describe("createSelfReadingAction redirects", () => {
  it("never pushes", () => {
    const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    const calls = source.match(/\bredirect\((?!\))[^)]*\)/g) ?? [];
    assert.ok(calls.length >= 2, "expected the redirects");
    for (const call of calls) assert.match(call, /, (RedirectType\.replace|next\.type)\)$/, call);
  });
});
