import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyItems, historyStatement, parseSelfResult } from "./self-history";

const ID = "00000000-0000-4000-8000-000000000001";

describe("historyStatement", () => {
  it("reads only the account's self-learner readings, newest first", () => {
    const s = historyStatement(ID);
    assert.match(s.text, /from self_readings\nwhere account_id = \$1::uuid\norder by created_at desc, id desc/);
    assert.equal(/classes|students|from readings/.test(s.text), false);
    assert.deepEqual(s.params, [ID]);
  });
});

describe("historyItems", () => {
  it("maps title, date, level, and result", () => {
    const items = historyItems(
      [
        { id: "r2", title: "Volcanoes", grade_level: "adult", status: "passed", created_at: new Date("2026-10-27T02:00:00Z") },
        { id: "r1", title: "Bees", grade_level: "4", status: "moved_on", created_at: "2026-10-20T12:00:00Z" },
        { id: "r0", title: "Rivers", grade_level: "K", status: "in_progress", created_at: "2026-10-19T12:00:00Z" },
      ],
      "America/New_York",
    );
    assert.deepEqual(
      items.map((i) => [i.id, i.title, i.gradeLabel, i.dateLabel, i.result, i.resultLabel]),
      [
        ["r2", "Volcanoes", "Adult", "Oct 26, 2026", "passed", "Passed"],
        ["r1", "Bees", "Grade 4", "Oct 20, 2026", "moved_on", "Moved on"],
        ["r0", "Rivers", "Kindergarten", "Oct 19, 2026", "in_progress", "In progress"],
      ],
    );
    assert.equal(items[0].isoDate, "2026-10-27T02:00:00.000Z");
  });

  it("treats an unknown status as in progress, and an empty list as empty", () => {
    assert.equal(parseSelfResult("weird"), "in_progress");
    assert.deepEqual(historyItems([], "UTC"), []);
  });
});
