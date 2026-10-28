import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLERK_COLORS, clerkAppearance } from "./clerk-appearance";

const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
const source = readFileSync(fileURLToPath(new URL("./clerk-appearance.ts", import.meta.url)), "utf8");

function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`, "i"));
  assert.ok(m, `no --color-${name} in globals.css`);
  return m[1].toLowerCase();
}

describe("clerk appearance", () => {
  it("every Clerk color is the theme token named beside it", () => {
    for (const [key, value] of Object.entries(CLERK_COLORS)) {
      const named = source.match(new RegExp(`${key}: "#[0-9a-f]{6}", // ([a-z]+(?:-\\d+)?)`));
      assert.ok(named, `${key} has no token comment`);
      assert.equal(value, token(named[1]), `${key} drifted from ${named[1]}`);
    }
  });

  it("puts Clerk's styles in the layer below Tailwind's utilities", () => {
    assert.equal(clerkAppearance.cssLayerName, "clerk");
    const order = css.match(/^@layer ([a-z, ]+);/m);
    assert.ok(order, "no @layer order in globals.css");
    const layers = order[1].split(/,\s*/);
    assert.ok(layers.indexOf("clerk") >= 0 && layers.indexOf("clerk") < layers.indexOf("utilities"));
    assert.ok(css.indexOf(order[0]) < css.indexOf('@import "tailwindcss"'), "the @layer order comes first");
  });
});
