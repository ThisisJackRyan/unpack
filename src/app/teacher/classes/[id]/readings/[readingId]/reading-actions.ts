"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { capAlreadyRaisedMessage, capRaisedMessage, CAP_RAISE_FAILED_MESSAGE } from "@/lib/reading-cap";
import { READING_DELETE_FAILED_MESSAGE, READING_DELETED_FLAG } from "@/lib/reading-delete";
import { deleteReading, raiseReadingCap } from "@/lib/readings";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { getOrCreateTeacher } from "@/lib/teacher";
import type { DeleteReadingState, RaiseCapState } from "./reading-state";

// Safe fields only (safe-error-fields.ts): a query error's message can
// echo a row.
function logError(where: string, error: unknown, classId: string, readingId: string) {
  console.error(where, { ...safeErrorFields(error), classId, readingId });
}

// Deletes the reading and everything under it. Ownership (the class is the
// teacher's, and the reading is in it) is checked in the delete itself
// (reading-delete.ts), in one transaction. Deleted, or already gone (a
// second click, another tab): back to the class page with a short
// confirmation. Another teacher's class is not found and changes nothing.
export async function deleteReadingAction(classId: string, readingId: string): Promise<DeleteReadingState> {
  const teacher = await getOrCreateTeacher();
  try {
    const result = await deleteReading(classId, teacher.id, readingId);
    if (result.status === "not_found") return { error: READING_DELETE_FAILED_MESSAGE };
  } catch (error) {
    logError("deleteReadingAction: delete failed", error, classId, readingId);
    return { error: READING_DELETE_FAILED_MESSAGE };
  }
  revalidatePath(`/teacher/classes/${classId}`, "layout");
  // redirect() throws, so it stays outside the try.
  redirect(`/teacher/classes/${classId}?notice=${READING_DELETED_FLAG}`);
}

// The one-time raise of the reading's student set cap (reading-cap.ts).
// A second raise (double click, two tabs) is a calm no-op.
export async function raiseCapAction(classId: string, readingId: string): Promise<RaiseCapState> {
  const teacher = await getOrCreateTeacher();
  try {
    const result = await raiseReadingCap(classId, teacher.id, readingId);
    if (result.status === "not_found") return { error: CAP_RAISE_FAILED_MESSAGE };
    revalidatePath(`/teacher/classes/${classId}/readings/${readingId}`);
    return {
      message: result.status === "raised" ? capRaisedMessage(result.limit) : capAlreadyRaisedMessage(result.limit),
    };
  } catch (error) {
    logError("raiseCapAction: raise failed", error, classId, readingId);
    return { error: CAP_RAISE_FAILED_MESSAGE };
  }
}
