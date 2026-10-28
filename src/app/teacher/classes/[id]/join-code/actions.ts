"use server";

import { revalidatePath } from "next/cache";
import { newJoinCode, setJoinCodeActive } from "@/lib/classes";
import { JoinCodeExhaustedError } from "@/lib/join-code";
import {
  JOIN_CODE_NEW_FAILED_MESSAGE,
  JOIN_CODE_OFF_MESSAGE,
  JOIN_CODE_ON_MESSAGE,
  JOIN_CODE_SAVE_FAILED_MESSAGE,
  newCodeMessage,
} from "@/lib/join-code-settings";
import { safeErrorFields } from "@/lib/safe-error-fields";
import { getOrCreateTeacher } from "@/lib/teacher";
import type { JoinCodeState } from "./state";

// Safe fields only (safe-error-fields.ts), as everywhere else.
function logError(where: string, error: unknown, classId: string) {
  console.error(where, { ...safeErrorFields(error), classId });
}

// Turns the code on or off. Sets the value the switch asked for (not a
// flip), with ownership checked in the update itself (join-code-settings.ts).
export async function setJoinCodeActiveAction(
  classId: string,
  _prev: JoinCodeState,
  formData: FormData,
): Promise<JoinCodeState> {
  const active = formData.get("active") === "on";
  const teacher = await getOrCreateTeacher();
  try {
    const result = await setJoinCodeActive(classId, teacher.id, active);
    if (result.status === "not_found") return { error: JOIN_CODE_SAVE_FAILED_MESSAGE };
    revalidatePath(`/teacher/classes/${classId}`);
    return { message: result.active ? JOIN_CODE_ON_MESSAGE : JOIN_CODE_OFF_MESSAGE };
  } catch (error) {
    logError("setJoinCodeActiveAction: save failed", error, classId);
    return { error: JOIN_CODE_SAVE_FAILED_MESSAGE };
  }
}

// Replaces the code. The old one stops working at once; students who
// already joined stay in.
export async function newJoinCodeAction(classId: string): Promise<JoinCodeState> {
  const teacher = await getOrCreateTeacher();
  try {
    const result = await newJoinCode(classId, teacher.id);
    if (result.status === "not_found") return { error: JOIN_CODE_NEW_FAILED_MESSAGE };
    revalidatePath(`/teacher/classes/${classId}`);
    return { message: newCodeMessage(result.code) };
  } catch (error) {
    if (!(error instanceof JoinCodeExhaustedError)) logError("newJoinCodeAction: save failed", error, classId);
    return { error: JOIN_CODE_NEW_FAILED_MESSAGE };
  }
}
