import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Teacher } from "@/db/schema";
import { atClassLimit, updateClassSettings } from "./classes";
import { classGradeChangeStatements, clearedDraftCount, draftsClearedByGradeChangeStatement } from "./shared-questions";

function teacher(plan: Teacher["plan"]): Teacher {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    clerkUserId: "user_test",
    name: null,
    email: "test@example.invalid",
    plan,
    createdAt: new Date(0),
    role: "teacher",
    ageConfirmedAt: null,
  };
}

describe("atClassLimit", () => {
  it("lets a free teacher with no classes create one", () => {
    assert.equal(atClassLimit(teacher("free"), 0), false);
  });

  it("stops a free teacher at 1 class", () => {
    assert.equal(atClassLimit(teacher("free"), 1), true);
    assert.equal(atClassLimit(teacher("free"), 2), true);
  });

  it("never limits a paid teacher", () => {
    for (const count of [0, 1, 2, 50, 1000]) {
      assert.equal(atClassLimit(teacher("paid"), count), false);
    }
  });
});

describe("classGradeChangeStatements", () => {
  const CLASS = "00000000-0000-4000-8000-00000000000c";
  const TEACHER = "00000000-0000-4000-8000-00000000000e";
  const statements = classGradeChangeStatements(CLASS, TEACHER, "6", "Room 12");
  const [lockClass, lockDrafts, clear, pin, update] = statements;

  it("is five statements: lock the class, lock drafts, clear, pin, update", () => {
    assert.equal(statements.length, 5);
  });

  it("locks the owned class, then the affected drafts", () => {
    assert.equal(
      lockClass.text,
      "select id from classes where id = $1::uuid and teacher_id = $2::uuid for no key update",
    );
    assert.match(lockDrafts.text, /for update of r$/);
  });

  it("clears shared questions only of drafts that follow the class grade, and only on a real change", () => {
    for (const s of [lockDrafts, clear]) {
      assert.match(s.text, /r\.class_id = \$1::uuid and r\.status = 'draft' and r\.grade_level is null/);
      assert.match(s.text, /c\.teacher_id = \$2::uuid/);
      assert.match(s.text, /c\.grade_level is distinct from \$3::grade_level/);
      assert.deepEqual(s.params, [CLASS, TEACHER, "6"]);
    }
    assert.match(clear.text, /^delete from questions q/);
    assert.match(clear.text, /q\.student_id is null/);
    assert.equal(/published/.test(clear.text), false);
  });

  it("pins the old class grade on published readings with no grade, only on a real change", () => {
    assert.match(pin.text, /^update readings r set grade_level = c\.grade_level\nfrom classes c\n/);
    assert.match(pin.text, /c\.id = r\.class_id and c\.id = \$1::uuid and c\.teacher_id = \$2::uuid/);
    assert.match(pin.text, /c\.grade_level is distinct from \$3::grade_level/);
    assert.match(pin.text, /r\.status = 'published' and r\.grade_level is null/);
    assert.equal(/'draft'/.test(pin.text), false);
    assert.deepEqual(pin.params, [CLASS, TEACHER, "6"]);
  });

  it("pins before the class update, so it reads the old grade, and after the class lock", () => {
    const texts = statements.map((s) => s.text);
    const pinAt = texts.findIndex((t) => t.startsWith("update readings"));
    const updateAt = texts.findIndex((t) => t.startsWith("update classes"));
    assert.ok(pinAt > 0 && pinAt < updateAt);
    assert.equal(updateAt, statements.length - 1);
  });

  it("updates the grade and name last", () => {
    assert.match(update.text, /^update classes set grade_level = \$3::grade_level, name = \$4::text\nwhere id = \$1::uuid and teacher_id = \$2::uuid\nreturning id$/);
    assert.deepEqual(update.params, [CLASS, TEACHER, "6", "Room 12"]);
  });

  it("never puts ids, the grade, or the name in the SQL", () => {
    for (const s of statements) {
      assert.equal(
        s.text.includes(CLASS) || s.text.includes(TEACHER) || s.text.includes("'6'") || s.text.includes("Room 12"),
        false,
      );
    }
  });
});

describe("updateClassSettings", () => {
  const CLASS = "00000000-0000-4000-8000-00000000000c";
  const TEACHER = "00000000-0000-4000-8000-00000000000e";

  it("counts the cleared drafts, not questions", () => {
    assert.equal(clearedDraftCount([[], [], [{ reading_id: "a" }, { reading_id: "a" }, { reading_id: "b" }], [], [{ id: CLASS }]]), 2);
    assert.equal(clearedDraftCount([[], [], [], [{ id: "p" }], [{ id: CLASS }]]), 0);
  });

  it("is saved with the cleared count, or not_found", async () => {
    const run = (updated: number, cleared: string[]) => async () => [
      [],
      [],
      cleared.map((reading_id) => ({ reading_id })),
      [],
      Array.from({ length: updated }, () => ({ id: CLASS })),
    ];
    assert.deepEqual(await updateClassSettings(CLASS, TEACHER, { name: "Room 12", gradeLevel: "6" }, run(1, ["a", "a", "a"])), {
      status: "saved",
      clearedDrafts: 1,
    });
    assert.deepEqual(await updateClassSettings(CLASS, TEACHER, { name: "Room 12", gradeLevel: "6" }, run(0, [])), { status: "not_found" });
    assert.deepEqual(await updateClassSettings("nope", TEACHER, { name: "Room 12", gradeLevel: "6" }, run(1, [])), { status: "not_found" });
  });

  it("counts the drafts a change would clear: owned drafts on the class grade with shared questions", () => {
    const s = draftsClearedByGradeChangeStatement(CLASS, TEACHER);
    assert.match(s.text, /r\.status = 'draft' and r\.grade_level is null/);
    assert.match(s.text, /c\.teacher_id = \$2::uuid/);
    assert.match(s.text, /q\.student_id is null/);
    assert.deepEqual(s.params, [CLASS, TEACHER]);
  });
});
