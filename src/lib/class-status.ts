// The teacher's class view: every student by every published reading,
// with a status (studentReadingStatus, the same derivation the student
// sees), tries used, and checks used. Pure statements and mapping, so tests
// check them; the server-only runner is class-status-db.ts. Every
// statement is scoped to the class AND its owning teacher.

import type { Statement } from "./link-rate-limit";
import { checksAllowedSql, latestChallengeSql, limitsFromRow, triesAllowedSql } from "./reading-limits";
import { latestChallenge, studentReadingStatus, type StudentReadingStatus } from "./reading-progress";

export type ClassStatusCell = {
  status: StudentReadingStatus;
  tries: number;
  triesAllowed: number;
  checks: number;
  checksAllowed: number;
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
  (select count(*)::int from effort_checks e where e.student_id = s.id and e.reading_id = r.id) as checks,
  lc.status as challenge, lc.extra_try,
  ${triesAllowedSql("s.id", "r.id")} as tries_allowed,
  ${checksAllowedSql("s.id", "r.id")} as checks_allowed
from classes c
join students s on s.class_id = c.id
join readings r on r.class_id = c.id and r.status = 'published'
left join lateral ${latestChallengeSql("s.id", "r.id")} lc on true
where ${OWNED}`,
      params: [classId, teacherId],
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
