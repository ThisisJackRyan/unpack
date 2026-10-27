import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { doneLabel } from "./done-count";

describe("doneLabel", () => {
  it("counts passed answers out of the reading's questions", () => {
    assert.equal(doneLabel(2, 3), "2 of 3 done");
    assert.equal(doneLabel(0, 3), "0 of 3 done");
    assert.equal(doneLabel(1, 1), "1 of 1 done");
  });

  it("never shows more done than there are, or a negative", () => {
    assert.equal(doneLabel(4, 3), "3 of 3 done");
    assert.equal(doneLabel(-1, 3), "0 of 3 done");
    assert.equal(doneLabel(Number.NaN, 2), "0 of 2 done");
  });
});
