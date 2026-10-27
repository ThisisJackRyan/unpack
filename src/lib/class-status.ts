// The teacher's class view: every student by every published reading,
// with a status (studentReadingStatus, the same derivation the student
// sees), tries used, and checks used. Pure statements and mapping, so tests
// check them; the server-only runner is class-status-db.ts. Every
// statement is scoped to the class AND its owning teacher.

import type { Statement } from "./link-rate-limit";
import { checksAllowedSql, countedCheckSql, latestChallengeSql, limitsFromRow, triesAllowedSql } from "./reading-limits";
import { latestChallenge, studentReadingStatus, type StudentReadingStatus } from "./reading-progress";
import { STUDENT_GENERATION_CALL_LIMIT } from "./student-questions-core";

export type ClassStatusCell = {
  status: StudentReadingStatus;
  tries: number;
  triesAllowed: number;
  checks: number;
  checksAllowed: number;
  // Used every answered "Try again" model call for this reading's own
  // questions (STUDENT_GENERATION_CALL_LIMIT; calls given back after an
  // outage don't count) without getting a set, and no call is
  // running: the student is stuck until the teacher uses "Let them try
  // again". Only possible on a per-student reading, and only while the
  // status is Not started (no questions means no tries).
  needsReset: boolean;
};

export type ClassStatusStudent = { id: string; name: string };
export type ClassStatusReading = { id: string; title: string };

export type ClassStatus = {
  readings: ClassStatusReading[];
  students: ClassStatusStudent[];
  // By `${studentId}:${readingId}`; a pair with no row is Not started.
  cells: Record<string, ClassStatusCell>;
};

// "Maya Ro": what the teacher sees for a student everywhere.
export function studentDisplayName(firstName: unknown, lastInitials: unknown): string {
  return `${String(firstName ?? "")} ${String(lastInitials ?? "")}`.trim();
}

export function cellKey(studentId: string, readingId: string): string {
  return `${studentId}:${readingId}`;
}

const OWNED = `c.id = $1::uuid and c.teacher_id = $2::uuid`;

// $1 class, $2 teacher.
export function classStatusStatements(classId: string, teacherId: string): Statement[] {
  return [
    {
      // Newest first, as on the class page.
      text: `select r.id, r.title from readings r join classes c on c.id = r.class_id
where ${OWNED} and r.status = 'published'
order by r.created_at desc, r.id desc`,
      params: [classId, teacherId],
    },
    {
      text: `select s.id, s.first_name, s.last_initials from students s join classes c on c.id = s.class_id
where ${OWNED}
order by lower(s.first_name), lower(s.last_initials), s.created_at, s.id`,
      params: [classId, teacherId],
    },
    {
      text: `select s.id as student_id, r.id as reading_id,
  exists (
    select 1 from attempts a where a.student_id = s.id and a.reading_id = r.id and a.result = 'pass'
  ) as passed,
  (select count(*)::int from attempts a where a.student_id = s.id and a.reading_id = r.id) as tries,
  (select count(*)::int from effort_checks e where e.student_id = s.id and e.reading_id = r.id and ${countedCheckSql("e")}) as checks,
  lc.status as challenge, lc.extra_try,
  ${triesAllowedSql("s.id", "r.id")} as tries_allowed,
  ${checksAllowedSql("s.id", "r.id")} as checks_allowed,
  (
    r.question_mode = 'per_student'
    and not exists (select 1 from questions q where q.reading_id = r.id and q.student_id = s.id)
    and not exists (
      select 1 from question_generations g
      where g.reading_id = r.id and g.student_id = s.id and g.status = 'pending'
    )
    and (select count(*) from student_question_calls k where k.reading_id = r.id and k.student_id = s.id and not k.given_back) >= $3::int
  ) as needs_reset
from classes c
join students s on s.class_id = c.id
join readings r on r.class_id = c.id and r.status = 'published'
left join lateral ${latestChallengeSql("s.id", "r.id")} lc on true
where ${OWNED}`,
      params: [classId, teacherId, STUDENT_GENERATION_CALL_LIMIT],
    },
  ];
}

export function classStatusCell(row: Record<string, unknown>): ClassStatusCell {
  const limits = limitsFromRow(row);
  const tries = Number(row.tries ?? 0);
  const checks = Number(row.checks ?? 0);
  return {
    status: studentReadingStatus({
      passed: row.passed === true,
      tries,
      checks,
      challenge: latestChallenge(row.challenge, row.extra_try),
      limits,
    }),
    tries,
    triesAllowed: limits.tries,
    checks,
    checksAllowed: limits.checks,
    needsReset: row.needs_reset === true,
  };
}

export function classStatus(results: Record<string, unknown>[][]): ClassStatus {
  const readings = (results[0] ?? []).map((r) => ({ id: String(r.id), title: String(r.title) }));
  const students = (results[1] ?? []).map((s) => ({
    id: String(s.id),
    name: studentDisplayName(s.first_name, s.last_initials),
  }));
  const cells: Record<string, ClassStatusCell> = {};
  for (const row of results[2] ?? []) {
    cells[cellKey(String(row.student_id), String(row.reading_id))] = classStatusCell(row);
  }
  return { readings, students, cells };
}

export const NOT_STARTED_CELL: ClassStatusCell = classStatusCell({});

// Under the Needs a reset pill. Says what happened without "tries", which
// on these pages means answer tries.
export const NEEDS_RESET_HELP = "Their questions didn’t load.";

// "2 of 3 tries"
export function triesLabel(cell: ClassStatusCell): string {
  return `${cell.tries} of ${cell.triesAllowed} ${cell.triesAllowed === 1 ? "try" : "tries"}`;
}

// Per reading: how many students are at each status, for the column
// headers and the stacked view.
export function statusCounts(status: ClassStatus, readingId: string): Record<StudentReadingStatus, number> {
  const counts: Record<StudentReadingStatus, number> = {
    not_started: 0,
    in_progress: 0,
    passed: 0,
    challenged: 0,
    challenge_denied: 0,
  };
  for (const s of status.students) {
    counts[(status.cells[cellKey(s.id, readingId)] ?? NOT_STARTED_CELL).status]++;
  }
  return counts;
}
