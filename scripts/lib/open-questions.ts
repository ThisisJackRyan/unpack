// The questions a student's answer form shows as editable: their set for
// the reading minus the locked ones (passed on the latest try), read with
// the app's own statements. For the db checks, which submit like the form.
import type { StatementExecutor } from "@/lib/link-rate-limit";
import { submitContextStatements, submitLookup } from "@/lib/submit-answers-core";

export async function openQuestionIds(execute: StatementExecutor, studentId: string, readingId: string): Promise<string[]> {
  const lookup = submitLookup(await execute(submitContextStatements(studentId, readingId)));
  if (lookup.status !== "ok") return [];
  const locked = new Set(lookup.context.lockedQuestionIds);
  return lookup.context.questions.filter((q) => !locked.has(q.id)).map((q) => q.id);
}
