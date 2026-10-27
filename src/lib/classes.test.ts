import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Teacher } from "@/db/schema";
import type { Statement } from "./link-rate-limit";
import { atClassLimit, updateClassGrade } from "./classes";
import { classGradeChangeStatements } from "./shared-questions";

function teacher(plan: Teacher["plan"]): Teacher {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    clerkUserId: "user_test",
    name: null,
    email: "test@example.invalid",
    plan,
    createdAt: new Date(0),
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
  const [lockClass, lockDrafts, clear, update] = classGradeChangeStatements(CLASS, TEACHER, "6");

  it("locks the owned class, then the affected drafts", () => {
    assert.equal(
      lockClass.text,
      "select id from classes where id = $1::uuid and teacher_id = $2::uuid for update",
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

  it("updates the grade last, so the clear sees the old one", () => {
    assert.match(update.text, /^update classes set grade_level = \$3::grade_level/);
    assert.match(update.text, /teacher_id = \$2::uuid\nreturning id$/);
  });

  it("never puts ids or the grade in the SQL", () => {
    for (const s of [lockClass, lockDrafts, clear, update]) {
      assert.equal(s.text.includes(CLASS) || s.text.includes(TEACHER) || s.text.includes("'6'"), false);
    }
  });

  it("applies when the update returns the class", async () => {
    const seen: Statement[][] = [];
    const execute = (rows: number) => async (statements: Statement[]) => {
      seen.push(statements);
      return statements.map((_, i) => (i === 3 ? Array.from({ length: rows }, () => ({ id: CLASS })) : []));
    };
    assert.equal(await updateClassGrade(CLASS, TEACHER, "6", execute(1)), true);
    assert.equal(await updateClassGrade(CLASS, TEACHER, "6", execute(0)), false);
    assert.equal(await updateClassGrade("nope", TEACHER, "6", execute(1)), false);
    assert.equal(seen.length, 2);
  });
});
