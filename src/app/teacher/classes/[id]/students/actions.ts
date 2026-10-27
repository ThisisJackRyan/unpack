"use server";

import { revalidatePath } from "next/cache";
import { deleteStudent, resetStudentQuestionCalls } from "@/lib/classes";
import { STUDENT_DELETE_FAILED_MESSAGE } from "@/lib/student-delete";
import { RESET_TRIES_FAILED_MESSAGE } from "@/lib/student-question-reset";
import { getOrCreateTeacher } from "@/lib/teacher";
import type { DeleteStudentState, ResetTriesState } from "./state";

// Deletes one student and everything under them. Ownership (this class is
// the teacher's, and the student is in it) is checked in the delete itself
// (student-delete.ts), in one transaction. A second click after it's gone
// is a no-op success; another teacher's class is not found and changes
// nothing.
export async function deleteStudentAction(
  classId: string,
  _prev: DeleteStudentState,
  formData: FormData,
): Promise<DeleteStudentState> {
  const studentId = String(formData.get("studentId") ?? "");
  const teacher = await getOrCreateTeacher();
  try {
    const result = await deleteStudent(classId, teacher.id, studentId);
    // Deleted, or already gone: either way the lists move on.
    revalidatePath(`/teacher/classes/${classId}`);
    revalidatePath(`/teacher/classes/${classId}/students`);
    revalidatePath(`/teacher/classes/${classId}/challenges`);
    return result.status === "not_found" ? { error: STUDENT_DELETE_FAILED_MESSAGE } : { deleted: true };
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo a
    // row, including a student's name.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("deleteStudentAction: delete failed", { name, code, message, classId });
    return { error: STUDENT_DELETE_FAILED_MESSAGE };
  }
}

// "Let them try again": resets one student's question-generation tries on
// one reading. Ownership (this class is the teacher's, and the student and
// reading are in it) is checked in the reset itself
// (student-question-reset.ts), in one statement, exactly like the delete.
// A repeat click is a no-op success; another teacher's (or a missing) id is
// not found and changes nothing.
export async function resetTriesAction(
  classId: string,
  _prev: ResetTriesState,
  formData: FormData,
): Promise<ResetTriesState> {
  const studentId = String(formData.get("studentId") ?? "");
  const readingId = String(formData.get("readingId") ?? "");
  const teacher = await getOrCreateTeacher();
  try {
    const result = await resetStudentQuestionCalls(classId, teacher.id, studentId, readingId);
    if (result.status === "not_found") return { error: RESET_TRIES_FAILED_MESSAGE };
    revalidatePath(`/teacher/classes/${classId}/students`);
    revalidatePath(`/teacher/classes/${classId}/students/${studentId}`);
    return { reset: true };
  } catch (error) {
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("resetTriesAction: reset failed", { name, code, message, classId });
    return { error: RESET_TRIES_FAILED_MESSAGE };
  }
}
