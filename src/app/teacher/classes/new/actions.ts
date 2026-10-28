"use server";

import { redirect } from "next/navigation";
import {
  atClassLimit,
  countClasses,
  insertClassIfAllowed,
} from "@/lib/classes";
import { JoinCodeExhaustedError } from "@/lib/join-code";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { getOrCreateTeacher } from "@/lib/teacher";
import { validateCreateClass } from "@/lib/validate-class";
import type { CreateClassState } from "./form-state";

export async function createClass(
  _prev: CreateClassState,
  formData: FormData,
): Promise<CreateClassState> {
  const result = validateCreateClass({
    name: formData.get("name"),
    gradeLevel: formData.get("gradeLevel"),
  });
  if (!result.ok) {
    return { errors: result.errors, values: result.values };
  }
  const { data, values } = result;

  const limitState: CreateClassState = {
    errors: { form: "The free plan includes 1 class." },
    values,
  };

  // Fast path for the UI; insertClassIfAllowed enforces the limit atomically.
  const teacher = await getOrCreateTeacher();
  if (atClassLimit(teacher, await countClasses(teacher.id))) {
    return limitState;
  }

  // redirect() throws, so it stays outside this try.
  let classId: string;
  try {
    const created = await insertClassIfAllowed(teacher.id, data);
    if (!created) return limitState;
    classId = created.id;
  } catch (error) {
    if (error instanceof JoinCodeExhaustedError) {
      return {
        errors: { form: "We couldn’t make a join code. Please try again." },
        values,
      };
    }
    // Safe fields only (safe-error-fields.ts): a query error's message can
    // echo the row, including the class name the teacher typed.
    console.error("createClass: insertClassIfAllowed failed", safeErrorFields(error));
    return {
      errors: { form: "We couldn’t create the class. Please try again." },
      values,
    };
  }

  redirect(`/teacher/classes/${classId}`);
}
