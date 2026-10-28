import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BURST_STARS, FIRST_TRY_LINE, KEPT_GOING_LINE, passLine } from "../lib/celebration";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("pass celebration", () => {
  it("says a short encouraging line: first try, or after a not yet", () => {
    assert.equal(passLine(1), FIRST_TRY_LINE);
    assert.equal(passLine(2), KEPT_GOING_LINE);
    assert.equal(passLine(3), KEPT_GOING_LINE);
    assert.equal(passLine(null), KEPT_GOING_LINE);
    assert.equal(KEPT_GOING_LINE, "You kept going and got there. That’s how strong readers grow.");
    for (const line of [FIRST_TRY_LINE, KEPT_GOING_LINE]) {
      assert.ok(!line.includes("'"), line);
      assert.ok(!line.includes("\u2014"), line);
    }
  });

  it("lands every star inside its 96px box", () => {
    assert.equal(BURST_STARS.length, 8);
    for (const star of BURST_STARS) {
      assert.ok(Math.abs(star.x) + star.size / 2 <= 48 && Math.abs(star.y) + star.size / 2 <= 48, JSON.stringify(star));
    }
  });

  it("is decorative, CSS only, and still under reduced motion", () => {
    const source = read("./celebration.tsx");
    assert.match(source, /aria-hidden="true"/);
    assert.doesNotMatch(source, /"use client"/);
    for (const m of source.matchAll(/\banimate-[a-z-]+/g)) {
      const before = source.slice(Math.max(0, m.index - 12), m.index);
      assert.ok(before.endsWith("motion-safe:"), m[0]);
    }
    // Without the animation, each star sits at its end position.
    assert.match(source, /transform: "translate\(var\(--tx\), var\(--ty\)\)"/);
    const css = read("../app/globals.css");
    assert.match(css, /--animate-burst: burst [^;]+ both;/);
    assert.match(css, /--animate-pop: pop [^;]+ both;/);
    assert.match(css, /@keyframes burst \{[\s\S]*translate\(var\(--tx\), var\(--ty\)\)/);
  });

  it("shows on a pass for students (not a teacher's accept) and self-learners", () => {
    assert.match(read("../app/c/r/[readingId]/page.tsx"), /\{!stage\.byTeacher && <PassCelebration tryNumber=\{stage\.attempt\?\.tryNumber\} \/>\}/);
    assert.match(read("../app/learn/r/[readingId]/page.tsx"), /<PassCelebration tryNumber=\{stage\.attempt\?\.tryNumber\} \/>/);
  });
});
