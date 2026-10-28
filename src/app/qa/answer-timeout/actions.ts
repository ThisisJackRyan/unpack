"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import type { AnswerFormState } from "@/components/answer-form-state";
import { qaRoutesEnabled } from "@/lib/qa-routes";

// The QA answer form's action: no database, no model. It waits `sleepMs`,
// re-renders the page (as a saved check, or a counted timeout, does), then
// redirects or returns a result. 404 unless UNPACK_QA_ROUTES=1.
export async function qaAnswerAction(
  sleepMs: number,
  redirectAfter: boolean,
  ...form: [prev: AnswerFormState, formData: FormData]
): Promise<AnswerFormState> {
  if (!qaRoutesEnabled()) notFound();
  const ms = Math.min(Math.max(Number(sleepMs) || 0, 0), 30_000);
  await new Promise((resolve) => setTimeout(resolve, ms));
  if (redirectAfter) redirect("/qa/answer-timeout/landed");
  revalidatePath("/qa/answer-timeout");
  const answers = [...form[1].keys()].length;
  return { message: `QA check finished after ${ms} ms, ${answers} answers.` };
}
