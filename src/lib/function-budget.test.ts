import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { EFFORT_CHECK_DEADLINE_MS, QUESTION_WRITE_DEADLINE_MS } from "./ai/settings";
import { EFFORT_CLAIM_STALE_SECONDS } from "./submit-answers-core";

// The pages whose server action runs the answer check (the action runs in
// the page's function, under its maxDuration). Next needs maxDuration as
// a literal in the page, so it's read from the source.
const CHECK_PAGES = ["src/app/c/r/[readingId]/page.tsx", "src/app/learn/r/[readingId]/page.tsx"];

// Vercel Hobby's most with Fluid compute.
const HOBBY_FLUID_MAX_SECONDS = 300;

// Room after the check's deadline for the lookups, the claim, the release
// or commit, and the re-render the action sends back.
const DB_AND_RENDER_SECONDS = 30;

function maxDuration(path: string): number {
  const match = readFileSync(path, "utf8").match(/^export const maxDuration = (\d+);$/m);
  assert.ok(match, `${path} sets maxDuration`);
  return Number(match[1]);
}

describe("function budget", () => {
  for (const path of CHECK_PAGES) {
    it(`the answer check ends well before ${path}'s maxDuration`, () => {
      const seconds = maxDuration(path);
      assert.ok(seconds <= HOBBY_FLUID_MAX_SECONDS);
      assert.ok(EFFORT_CHECK_DEADLINE_MS / 1000 + DB_AND_RENDER_SECONDS <= seconds);
      // A live claim is never stale while its check can still run.
      assert.ok(EFFORT_CLAIM_STALE_SECONDS * 1000 > EFFORT_CHECK_DEADLINE_MS);
      // The first open may write questions in the same function.
      assert.ok(QUESTION_WRITE_DEADLINE_MS / 1000 < seconds);
    });
  }
});
