"use server";

import { revalidatePath } from "next/cache";
import { decideChallenge, type DecideResult } from "@/lib/challenge-queue";
import { DECIDE_FAILED_MESSAGE, parseDecisionChoice } from "@/lib/challenge-queue-core";
import { getOrCreateTeacher } from "@/lib/teacher";
import type { DecideState } from "./state";

// Accept or Deny one challenge (Deny optionally with one more try). Ownership (the class is this teacher's,
// and the challenge is in it), "still open", and the one-more-try grant
// are all checked in the decision's own transaction (see
// challenge-queue-core.ts), so a double-click or a second tab gets
// "already decided" and nothing else changes.
export async function decideChallengeAction(
  classId: string,
  _prev: DecideState,
  formData: FormData,
): Promise<DecideState> {
  const challengeId = String(formData.get("challengeId") ?? "");
  // Accept, Deny, or "Deny, give one more try": each its own button.
  const choice = parseDecisionChoice(formData.get("decision"));
  if (!choice) return { challengeId, error: DECIDE_FAILED_MESSAGE };
  const { decision, extraTry } = choice;

  const teacher = await getOrCreateTeacher();
  let result: DecideResult;
  try {
    result = await decideChallenge({ challengeId, classId, teacherId: teacher.id, decision, extraTry });
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo a
    // row, including a student's note.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("decideChallengeAction: decide failed", { name, code, message, classId });
    return { challengeId, error: DECIDE_FAILED_MESSAGE };
  }
  // Decided, or already decided elsewhere: either way the list, the
  // count, and the class view move on.
  revalidatePath(`/teacher/classes/${classId}`);
  revalidatePath(`/teacher/classes/${classId}/challenges`);
  revalidatePath(`/teacher/classes/${classId}/students`);
  return { challengeId, result };
}
