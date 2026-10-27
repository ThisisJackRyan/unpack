import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { metaParts, metaSpokenText } from "./meta-line";
import { EMPTY_STATE_COPY, historyItems, historyStatement, parseSelfResult } from "./self-history";

const ID = "00000000-0000-4000-8000-000000000001";

describe("historyStatement", () => {
  it("reads only the account's self-learner readings, newest first", () => {
    const s = historyStatement(ID);
    assert.match(s.text, /from self_readings r\nwhere r\.account_id = \$1::uuid\norder by r\.created_at desc, r\.id desc/);
    // Passed answers on the reading's latest try only.
    assert.match(s.text, /from self_answers an\s+where an\.ai_pass and an\.attempt_id = \(\s+select a\.id from self_attempts a where a\.reading_id = r\.id order by a\.try_number desc limit 1/);
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
  });

  it("leaves no stray separator when the level is missing", () => {
    const [item] = historyItems([{ id: "r", title: "T", grade_level: "weird", status: "in_progress", created_at: "2026-10-19T12:00:00Z" }], "UTC");
    assert.equal(item.gradeLabel, "");
    assert.deepEqual(metaParts([item.dateLabel, item.gradeLabel]), ["Oct 19, 2026"]);
    assert.equal(metaSpokenText([item.dateLabel, item.gradeLabel]), "Oct 19, 2026");
  });

  it("adds X of Y done to in-progress rows only", () => {
    const items = historyItems(
      [
        { id: "a", title: "A", grade_level: "5", status: "in_progress", created_at: "2026-10-19T12:00:00Z", question_count: 3, passed_answers: 2 },
        { id: "b", title: "B", grade_level: "5", status: "in_progress", created_at: "2026-10-19T12:00:00Z", question_count: 4 },
        { id: "c", title: "C", grade_level: "5", status: "passed", created_at: "2026-10-19T12:00:00Z", question_count: 3, passed_answers: 3 },
        { id: "d", title: "D", grade_level: "5", status: "moved_on", created_at: "2026-10-19T12:00:00Z", question_count: 3, passed_answers: 1 },
      ],
      "UTC",
    );
    assert.deepEqual(items.map((i) => i.doneLabel), ["2 of 3 done", "0 of 4 done", "", ""]);
    assert.equal(metaSpokenText([items[0].dateLabel, items[0].gradeLabel, items[0].doneLabel]), "Oct 19, 2026, Grade 5, 2 of 3 done");
  });

  it("treats an unknown status as in progress, and an empty list as empty", () => {
    assert.equal(parseSelfResult("weird"), "in_progress");
    assert.deepEqual(historyItems([], "UTC"), []);
  });
});

describe("EMPTY_STATE_COPY", () => {
  it("gives /learn/history its own copy, not the /learn copy", () => {
    const { learn, history } = EMPTY_STATE_COPY;
    assert.notEqual(history.heading, learn.heading);
    assert.notEqual(history.body, learn.body);
    assert.equal(history.heading, "Nothing read yet");
    assert.match(history.body, /listed here/);
    for (const label of ["In progress", "Passed", "Moved on"]) assert.ok(history.body.includes(label), label);
    assert.equal(history.button, "Start your first reading");
  });

  it("uses curly apostrophes and no em dashes", () => {
    for (const copy of Object.values(EMPTY_STATE_COPY)) {
      for (const text of Object.values(copy)) {
        assert.ok(!text.includes("'"), text);
        assert.ok(!text.includes("\u2014"), text);
      }
    }
  });
});
