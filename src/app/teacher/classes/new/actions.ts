"use server";

import { redirect } from "next/navigation";
import {
  atClassLimit,
  countClasses,
  insertClassIfAllowed,
} from "@/lib/classes";
import { isGradeLevel } from "@/lib/grade-levels";
import { JoinCodeExhaustedError } from "@/lib/join-code";
import { getOrCreateTeacher } from "@/lib/teacher";
import { CLASS_NAME_MAX_LENGTH, type CreateClassState } from "./form-state";

export async function createClass(
  _prev: CreateClassState,
  formData: FormData,
): Promise<CreateClassState> {
  const rawName = formData.get("name");
  const rawGrade = formData.get("gradeLevel");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const gradeLevel = typeof rawGrade === "string" ? rawGrade : "";
  const values = { name, gradeLevel };

  const errors: NonNullable<CreateClassState["errors"]> = {};
  if (!name) {
    errors.name = "Enter a class name.";
  } else if (name.length > CLASS_NAME_MAX_LENGTH) {
    errors.name = `Keep the name to ${CLASS_NAME_MAX_LENGTH} characters or less.`;
  }
  if (!isGradeLevel(gradeLevel)) {
    errors.gradeLevel = "Choose a grade level.";
  }
  if (errors.name || errors.gradeLevel || !isGradeLevel(gradeLevel)) {
    return { errors, values };
  }

  const limitState: CreateClassState = {
    errors: { form: "The free plan includes 1 class." },
    values,
  };

  // Fast path for the UI; insertClassIfAllowed enforces the limit atomically.
  const teacher = await getOrCreateTeacher();
  if (atClassLimit(teacher, await countClasses(teacher.id))) {
    return limitState;
  }

  let classId: string;
  try {
    const created = await insertClassIfAllowed(teacher.id, { name, gradeLevel });
    if (!created) return limitState;
    classId = created.id;
  } catch (error) {
    if (error instanceof JoinCodeExhaustedError) {
      return {
        errors: { form: "We couldn’t make a join code. Please try again." },
        values,
      };
    }
    throw error;
  }

  redirect(`/teacher/classes/${classId}`);
}
