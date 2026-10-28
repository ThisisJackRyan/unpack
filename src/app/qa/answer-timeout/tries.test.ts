import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QA_TRIES_MAX_RUNS, qaLastTry, saveQaTry } from "./tries";

describe("the QA try store", () => {
  it("keeps the most recent QA_TRIES_MAX_RUNS runs, dropping the oldest", () => {
    assert.equal(QA_TRIES_MAX_RUNS, 200);
    saveQaTry("first", { q: "a" });
    saveQaTry("first", { q: "b" });
    assert.equal(qaLastTry("first")?.tryNumber, 2);
    for (let i = 0; i < QA_TRIES_MAX_RUNS - 1; i += 1) saveQaTry(`run-${i}`, { q: "x" });
    // Exactly at the cap: nothing dropped yet.
    assert.equal(qaLastTry("first")?.tryNumber, 2);
    // A new try on "first" makes it the newest, so run-0 goes next.
    saveQaTry("first", { q: "c" });
    saveQaTry("one-more", { q: "x" });
    assert.equal(qaLastTry("run-0"), null);
    assert.equal(qaLastTry("first")?.tryNumber, 3);
    assert.equal(qaLastTry("run-1")?.tryNumber, 1);
    for (let i = 0; i < 1_000; i += 1) saveQaTry(`flood-${i}`, { q: "x" });
    const store = (globalThis as { __unpackQaTries?: Map<string, unknown> }).__unpackQaTries;
    assert.equal(store?.size, QA_TRIES_MAX_RUNS);
    assert.equal(qaLastTry("first"), null);
    assert.equal(qaLastTry("flood-999")?.tryNumber, 1);
  });
});
