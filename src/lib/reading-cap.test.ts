import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAP_NEAR_THRESHOLD,
  capAlreadyRaisedMessage,
  capBadgeDetail,
  capBadgeLabel,
  capDetail,
  capHeadline,
  capLevel,
  capNearThreshold,
  classCapBadges,
  classCapsStatement,
  capRaisedMessage,
  capView,
  raiseCapStatement,
  raiseReadingCapWith,
  readingCapFromRows,
  readingCapStatement,
} from "./reading-cap";
import { STUDENT_SETS_PER_READING_LIMIT, STUDENT_SETS_RAISED_LIMIT } from "./student-questions-core";

describe("raiseCapStatement", () => {
  const s = raiseCapStatement("c1", "t1", "r1");

  it("raises only the owner's published per-student reading, once, in one statement", () => {
    assert.match(s.text, /where r\.id = \$3::uuid and r\.class_id = \$1::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
    assert.match(s.text, /insert into reading_cap_raises \(reading_id, teacher_id, from_limit, to_limit\)\s+select id, \$2::uuid, \$4::int, \$5::int from owned\s+on conflict \(reading_id\) do nothing/);
    assert.deepEqual(s.params, ["c1", "t1", "r1", 150, 300]);
  });

  it("is 150 to 300", () => {
    assert.equal(STUDENT_SETS_PER_READING_LIMIT, 150);
    assert.equal(STUDENT_SETS_RAISED_LIMIT, 300);
  });
});

describe("raiseReadingCapWith", () => {
  it("reads raised, already raised, and not found", async () => {
    let n = 0;
    const raised = await raiseReadingCapWith("c1", "t1", "r1", async (st) => {
      n += st.length;
      return [[{ owned: 1, raised: 1, to_limit: 300 }]];
    });
    assert.deepEqual(raised, { status: "raised", limit: 300 });
    assert.equal(n, 1);
    assert.deepEqual(await raiseReadingCapWith("c1", "t1", "r1", async () => [[{ owned: 1, raised: 0, to_limit: null }]]), {
      status: "already_raised",
      limit: 300,
    });
    assert.deepEqual(await raiseReadingCapWith("c1", "t2", "r1", async () => [[{ owned: 0, raised: 0 }]]), { status: "not_found" });
    assert.deepEqual(await raiseReadingCapWith("c1", "t2", "r1", async () => [[]]), { status: "not_found" });
  });
});

describe("the reading's cap", () => {
  it("counts claims against the raised cap, else the default, scoped to the owner", () => {
    const s = readingCapStatement("c1", "t1", "r1");
    assert.match(s.text, /count\(\*\)::int from question_generations g where g\.reading_id = r\.id\) as used/);
    assert.match(s.text, /coalesce\(\(select x\.to_limit from reading_cap_raises x where x\.reading_id = r\.id\), \$4::int\)::int as cap/);
    assert.match(s.text, /c\.teacher_id = \$2::uuid/);
    assert.deepEqual(s.params, ["c1", "t1", "r1", 150]);
    assert.deepEqual(readingCapFromRows([[{ used: 12, cap: 150, raised: false }]]), { used: 12, limit: 150, raised: false });
    assert.equal(readingCapFromRows([[]]), undefined);
  });

  it("shows nothing well under the cap, a note and the button near and at it, the new limit after", () => {
    assert.equal(CAP_NEAR_THRESHOLD, 135);
    assert.deepEqual(capView({ used: 0, limit: 150, raised: false }), { kind: "none" });
    assert.deepEqual(capView({ used: 134, limit: 150, raised: false }), { kind: "none" });
    assert.deepEqual(capView({ used: 135, limit: 150, raised: false }), { kind: "near", used: 135, limit: 150, raiseTo: 300 });
    assert.deepEqual(capView({ used: 150, limit: 150, raised: false }), { kind: "full", used: 150, limit: 150, raiseTo: 300 });
    assert.deepEqual(capView({ used: 150, limit: 300, raised: true }), { kind: "raised", used: 150, limit: 300 });
    assert.deepEqual(capView({ used: 284, limit: 300, raised: true }), { kind: "raised", used: 284, limit: 300 });
    assert.deepEqual(capView({ used: 285, limit: 300, raised: true }), { kind: "raised_near", used: 285, limit: 300 });
    assert.deepEqual(capView({ used: 299, limit: 300, raised: true }), { kind: "raised_near", used: 299, limit: 300 });
    assert.deepEqual(capView({ used: 300, limit: 300, raised: true }), { kind: "raised_full", used: 300, limit: 300 });
  });

  it("has calm copy", () => {
    assert.equal(capHeadline({ kind: "full", used: 150, limit: 150, raiseTo: 300 }), "This reading is full (150 students)");
    assert.equal(capHeadline({ kind: "near", used: 140, limit: 150, raiseTo: 300 }), "This reading is almost full (140 of 150 students)");
    assert.equal(capHeadline({ kind: "raised", used: 151, limit: 300 }), "Limit raised to 300 students");
    assert.equal(capHeadline({ kind: "raised_full", used: 300, limit: 300 }), "This reading is full (300 students)");
    assert.equal(capHeadline({ kind: "raised_near", used: 290, limit: 300 }), "This reading is almost full (290 of 300 students)");
    assert.equal(capRaisedMessage(300), "Limit raised to 300 students.");
    assert.equal(capAlreadyRaisedMessage(300), "The limit was already raised to 300 students.");
  });

  it("says what students see and whether it can go higher", () => {
    const asked = "“Ask your teacher for help with this one.”";
    assert.equal(
      capDetail({ kind: "full", used: 150, limit: 150, raiseTo: 300 }),
      `New students who open it now see ${asked} Students who already have their questions keep them.`,
    );
    assert.equal(
      capDetail({ kind: "near", used: 140, limit: 150, raiseTo: 300 }),
      `Once 150 students have their own questions, new students who open it see ${asked}`,
    );
    assert.equal(
      capDetail({ kind: "raised", used: 151, limit: 300 }),
      "151 of 300 students have their own questions. The limit can only be raised once.",
    );
    assert.equal(
      capDetail({ kind: "raised_near", used: 290, limit: 300 }),
      `Once 300 students have their own questions, new students who open it see ${asked} The limit was raised once already, so it can’t go higher.`,
    );
    assert.equal(
      capDetail({ kind: "raised_full", used: 300, limit: 300 }),
      `New students who open it now see ${asked} Students who already have their questions keep them. The limit was raised once already, so it can’t go higher.`,
    );
  });
});

describe("the class page's cap badges", () => {
  it("is near 15 students short of either limit, full at it", () => {
    assert.equal(capNearThreshold(150), CAP_NEAR_THRESHOLD);
    assert.equal(capNearThreshold(300), 285);
    assert.equal(capLevel(134, 150), "ok");
    assert.equal(capLevel(135, 150), "near");
    assert.equal(capLevel(150, 150), "full");
    assert.equal(capLevel(151, 300), "ok");
    assert.equal(capLevel(284, 300), "ok");
    assert.equal(capLevel(285, 300), "near");
    assert.equal(capLevel(300, 300), "full");
  });

  it("agrees with the panel on an unraised reading", () => {
    for (const used of [0, 134, 135, 149, 150]) {
      const kind = capView({ used, limit: 150, raised: false }).kind;
      const level = capLevel(used, 150);
      assert.equal(kind === "none" ? "ok" : kind, level);
    }
  });

  it("is one grouped count, owner-scoped, over published per-student readings", () => {
    const s = classCapsStatement("c1", "t1");
    assert.match(s.text, /count\(\*\)::int as used/);
    assert.match(s.text, /coalesce\(max\(x\.to_limit\), \$3::int\)::int as cap/);
    assert.match(s.text, /join question_generations g on g\.reading_id = r\.id/);
    assert.match(s.text, /left join reading_cap_raises x on x\.reading_id = r\.id/);
    assert.match(s.text, /r\.class_id = \$1::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /r\.status = 'published' and r\.question_mode = 'per_student'/);
    assert.match(s.text, /group by r\.id$/);
    assert.deepEqual(s.params, ["c1", "t1", 150]);
  });

  it("keeps only readings near or at their limit", () => {
    const badges = classCapBadges([
      [
        { reading_id: "a", used: 10, cap: 150 },
        { reading_id: "b", used: 140, cap: 150 },
        { reading_id: "c", used: 150, cap: 150 },
        { reading_id: "d", used: 200, cap: 300 },
        { reading_id: "e", used: 290, cap: 300 },
        { reading_id: "f", used: 300, cap: 300 },
      ],
    ]);
    assert.deepEqual([...badges.keys()], ["b", "c", "e", "f"]);
    assert.deepEqual(badges.get("e"), { level: "near", used: 290, limit: 300 });
    assert.deepEqual(badges.get("f"), { level: "full", used: 300, limit: 300 });
    assert.equal(classCapBadges([[]]).size, 0);
  });

  it("has short, calm copy", () => {
    assert.equal(capBadgeLabel("near"), "Almost full");
    assert.equal(capBadgeLabel("full"), "Full");
    assert.equal(capBadgeDetail({ level: "near", used: 140, limit: 150 }), "140 of 150 students have their own questions");
  });
});
