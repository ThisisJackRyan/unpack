import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  browserSessionStore,
  BURST_MS,
  BURST_STAGGER_MS,
  BURST_STARS,
  FIRST_TRY_LINE,
  JUST_CHECKED_KEY,
  JUST_CHECKED_MAX_AGE_MS,
  KEPT_GOING_LINE,
  markJustChecked,
  passLine,
  POP_MS,
  takeJustChecked,
} from "../lib/celebration";

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

  it("is decorative, and still under reduced motion", () => {
    const source = read("./celebration.tsx");
    assert.match(source, /aria-hidden="true"/);
    for (const m of source.matchAll(/\b(animate|opacity)-[a-z0-9-]+/g)) {
      const before = source.slice(Math.max(0, m.index - 12), m.index);
      assert.ok(before.endsWith("motion-safe:"), m[0]);
    }
    // Without the animation, each star sits at its end position.
    assert.match(source, /transform: "translate\(var\(--tx\), var\(--ty\)\)"/);
    const css = read("../app/globals.css");
    assert.match(css, /--animate-burst: burst [^;]+ both;/);
    assert.match(css, /--animate-pop: pop [^;]+ both;/);
    assert.match(css, /@keyframes burst \{[\s\S]*translate\(var\(--tx\), var\(--ty\)\)/);
    // The scroll jumps instead of gliding under reduced motion.
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.match(source, /behavior: still \? "auto" : "smooth"/);
  });

  it("runs about 1.5 to 2 seconds, in step with the CSS", () => {
    const css = read("../app/globals.css");
    const seconds = (name: string) => Number(new RegExp(`--animate-${name}: ${name} ([\\d.]+)s `).exec(css)?.[1]) * 1000;
    assert.equal(seconds("burst"), BURST_MS);
    assert.equal(seconds("pop"), POP_MS);
    const lastStar = Math.max(...BURST_STARS.map((s) => s.delayMs + BURST_MS));
    const total = Math.max(lastStar, POP_MS);
    assert.ok(total >= 1500 && total <= 2000, String(total));
    assert.equal(BURST_STAGGER_MS, 120);
  });

  // C7: the celebration used to play its 0.8s burst on mount, while it was
  // above the screen (right after a check, the form is swapped in place)
  // or below the reading text (a later visit), so it was never seen.
  it("plays only once on screen, and scrolls into view after a passing check", () => {
    const source = read("./celebration.tsx");
    assert.match(source, /^"use client";/);
    assert.match(source, /new IntersectionObserver\(/);
    assert.match(source, /threshold: VISIBLE_SHARE/);
    assert.match(source, /const motion = play \? "motion-safe:animate-burst" : "motion-safe:opacity-0";/);
    assert.match(source, /const popMotion = play \? "motion-safe:animate-pop" : "motion-safe:opacity-0";/);
    assert.match(source, /if \(takeJustChecked\(browserSessionStore\(\), readingId\)\) \{[\s\S]*scrollIntoView\(\{ block: "center"/);
    assert.match(source, /observer\.disconnect\(\)/);
    const form = read("./answer-form.tsx");
    const submit = form.slice(form.indexOf("function onSubmit"), form.indexOf("return (", form.indexOf("function onSubmit")));
    assert.ok(submit.indexOf("markJustChecked(browserSessionStore(), readingId)") < submit.indexOf("startTransition"), submit);
  });

  it("shows on a pass for students (not a teacher's accept) and self-learners", () => {
    assert.match(
      read("../app/c/r/[readingId]/page.tsx"),
      /\{!stage\.byTeacher && <PassCelebration tryNumber=\{stage\.attempt\?\.tryNumber\} readingId=\{readingId\} \/>\}/,
    );
    assert.match(read("../app/learn/r/[readingId]/page.tsx"), /<PassCelebration tryNumber=\{stage\.attempt\?\.tryNumber\} readingId=\{readingId\} \/>/);
  });
});

describe("just checked mark", () => {
  function memory() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("is taken once, for the same reading, soon after the check", () => {
    const store = memory();
    markJustChecked(store, "r1", 1_000);
    assert.equal(takeJustChecked(store, "r2", 2_000), false);
    assert.equal(takeJustChecked(store, "r1", 2_000), true);
    assert.equal(takeJustChecked(store, "r1", 2_100), false);
  });

  it("ignores an old mark, and drops it", () => {
    const store = memory();
    markJustChecked(store, "r1", 0);
    assert.equal(takeJustChecked(store, "r1", JUST_CHECKED_MAX_AGE_MS + 1), false);
    assert.equal(store.map.size, 0);
    markJustChecked(store, "r1", 0);
    assert.equal(takeJustChecked(store, "r1", JUST_CHECKED_MAX_AGE_MS), true);
  });

  it("holds ids and a time only", () => {
    const store = memory();
    markJustChecked(store, "r1", 5);
    assert.deepEqual(JSON.parse(store.map.get(JUST_CHECKED_KEY) ?? ""), { readingId: "r1", at: 5 });
  });

  it("never throws: no storage, blocked storage, or junk", () => {
    assert.equal(takeJustChecked(null, "r1"), false);
    markJustChecked(null, "r1");
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    markJustChecked(blocked, "r1");
    assert.equal(takeJustChecked(blocked, "r1"), false);
    const junk = memory();
    junk.setItem(JUST_CHECKED_KEY, "{not json");
    assert.equal(takeJustChecked(junk, "r1"), false);
    assert.equal(browserSessionStore(), null);
  });
});
