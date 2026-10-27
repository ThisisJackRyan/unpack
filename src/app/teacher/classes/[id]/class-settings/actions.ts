"use server";

import { revalidatePath } from "next/cache";
import { CLASS_SETTINGS_FAILED_MESSAGE, classSettingsSavedMessage } from "@/lib/class-settings";
import { updateClassSettings } from "@/lib/classes";
import { getOrCreateTeacher } from "@/lib/teacher";
import { validateCreateClass } from "@/lib/validate-class";
import type { ClassSettingsState } from "./state";

// Saves the class name and grade level, validated like a new class. One
// transaction with ownership checked in it (updateClassSettings); a grade
// change clears the shared questions of drafts on the class grade, a
// same-grade save clears nothing.
export async function saveClassSettingsAction(
  classId: string,
  _prev: ClassSettingsState,
  formData: FormData,
): Promise<ClassSettingsState> {
  const result = validateCreateClass({ name: formData.get("name"), gradeLevel: formData.get("gradeLevel") });
  if (!result.ok) return { errors: result.errors, values: result.values };
  const teacher = await getOrCreateTeacher();
  try {
    const saved = await updateClassSettings(classId, teacher.id, result.data);
    if (saved.status === "not_found") return { error: CLASS_SETTINGS_FAILED_MESSAGE, values: result.values };
    revalidatePath(`/teacher/classes/${classId}`, "layout");
    revalidatePath("/teacher");
    return { message: classSettingsSavedMessage(saved.clearedDrafts), values: result.values };
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo the
    // row, including the class name.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("saveClassSettingsAction: save failed", { name, code, message, classId });
    return { error: CLASS_SETTINGS_FAILED_MESSAGE, values: result.values };
  }
}
