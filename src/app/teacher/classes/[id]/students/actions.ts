"use server";

import { revalidatePath } from "next/cache";
import { deleteStudent } from "@/lib/classes";
import { STUDENT_DELETE_FAILED_MESSAGE } from "@/lib/student-delete";
import { getOrCreateTeacher } from "@/lib/teacher";
import type { DeleteStudentState } from "./state";

// Deletes one student and everything under them. Ownership (this class is
// the teacher's, and the student is in it) is checked in the delete itself
// (student-delete.ts), in one transaction. Not found (another teacher, or
// a second click after it's gone) changes nothing.
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
    return result.status === "deleted" ? { deleted: true } : { error: STUDENT_DELETE_FAILED_MESSAGE };
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo a
    // row, including a student's name.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("deleteStudentAction: delete failed", { name, code, message, classId });
    return { error: STUDENT_DELETE_FAILED_MESSAGE };
  }
}
