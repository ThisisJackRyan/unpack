// The "2 of 3 done" hint on an In progress reading's row (the student's
// class list, the self-learner's /learn and history). Done means the
// answers that passed on the latest try, the same count as the reading
// page's "Not yet. 2 of 3 answers passed." Out of the reading's question
// count (the "3 questions" a student sees on the row). Pure, so tests
// cover it.

// Clamped, so a reading whose count changed can't show "4 of 3".
export function doneLabel(passed: number, total: number): string {
  const all = Math.max(0, Math.trunc(total));
  const done = Math.min(all, Math.max(0, Math.trunc(passed) || 0));
  return `${done} of ${all} done`;
}
