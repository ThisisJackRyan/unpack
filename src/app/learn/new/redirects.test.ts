import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// A server action's redirect() pushes by default, which would leave the
// filled-in form behind the new reading in history. Every redirect in the
// create action must say how it navigates: the action redirects only to
// what createSelfReadingWith returns, and every redirect that returns is a
// replace (CreateRedirect's type is "replace"; self-reading-create.test.ts
// checks each one).
describe("createSelfReadingAction redirects", () => {
  it("never pushes", () => {
    const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    const calls = source.match(/\bredirect\((?!\))[^)]*\)/g) ?? [];
    assert.ok(calls.length >= 1, "expected the redirect");
    for (const call of calls) assert.match(call, /, (RedirectType\.replace|next\.type)\)$/, call);
  });
});
