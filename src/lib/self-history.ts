// A self-learner's history: every reading they started, newest first, with
// its result. Pure (SQL text and mapping); scoped to the account in the
// statement, so it never reads class or student rows.

import { gradeLevelLabel, isGradeLevel } from "./grade-levels";
import type { Statement } from "./link-rate-limit";

export type SelfReadingResult = "in_progress" | "passed" | "moved_on";

export const SELF_RESULT_LABELS: Record<SelfReadingResult, string> = {
  in_progress: "In progress",
  passed: "Passed",
  moved_on: "Moved on",
};

// The empty state on /learn (where to start) and on /learn/history (what
// will show up there). Each screen has its own copy.
export const EMPTY_STATE_COPY = {
  learn: {
    heading: "No readings yet",
    body: "Paste a link or some text you want to read. We’ll ask you a few questions about it.",
    button: "Start a new reading",
  },
  history: {
    heading: "Nothing read yet",
    body: `Every reading you start will be listed here, newest first, with its date, its level, and how it went: ${SELF_RESULT_LABELS.in_progress}, ${SELF_RESULT_LABELS.passed}, or ${SELF_RESULT_LABELS.moved_on}.`,
    button: "Start your first reading",
  },
} as const;

export type EmptyStateScreen = keyof typeof EMPTY_STATE_COPY;

export function parseSelfResult(value: unknown): SelfReadingResult {
  return value === "passed" || value === "moved_on" ? value : "in_progress";
}

export type HistoryItem = {
  id: string;
  title: string;
  gradeLabel: string;
  // "Oct 27, 2026", in the reader's zone, formatted on the server.
  dateLabel: string;
  result: SelfReadingResult;
  resultLabel: string;
};

export function historyStatement(accountId: string): Statement {
  return {
    text: `select id, title, grade_level, status, created_at
from self_readings
where account_id = $1::uuid
order by created_at desc, id desc`,
    params: [accountId],
  };
}

function asDate(value: unknown): Date {
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

export function historyItems(rows: Record<string, unknown>[], timeZone: string): HistoryItem[] {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
  return rows.map((row) => {
    const created = asDate(row.created_at);
    const result = parseSelfResult(row.status);
    return {
      id: String(row.id),
      title: String(row.title),
      gradeLabel: isGradeLevel(row.grade_level) ? gradeLevelLabel(row.grade_level) : "",
      dateLabel: format.format(created),
      result,
      resultLabel: SELF_RESULT_LABELS[result],
    };
  });
}
