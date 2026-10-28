import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Guards the favicon SVG served from the site root (/icon.svg) against active content.
const SVG = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");

describe("icon.svg", () => {
  it("has an <svg> root element", () => {
    assert.match(SVG, /^\s*<svg[\s>]/i);
  });

  it("has no script, foreignObject, links, or event handlers", () => {
    assert.doesNotMatch(SVG, /<script\b/i);
    assert.doesNotMatch(SVG, /<foreignObject\b/i);
    assert.doesNotMatch(SVG, /\s(xlink:)?href\s*=/i);
    assert.doesNotMatch(SVG, /\son[a-z]+\s*=/i);
  });
});
