// What the reading form shows when its request got no usable answer (see
// withRejectionFallback in action-fallback.ts): a message in the form's
// error box, and every value it sent back in the fields, so the pasted
// text, the link, the title, the level and the counts are never lost.
//
// No client time limit for these forms (unlike the answer check's
// CLIENT_CHECK_TIMEOUT_MS). The server's own bounds end every create: the
// lookups before the first write give up at PRE_WRITE_DEADLINE_MS, a link
// fetch at FETCH_DEADLINE_MS, and the page's maxDuration ends anything
// else with a 504, which lands here as no reply. A client limit would add
// a duplicate risk: Next runs one server action at a time, so a create
// the form gave up on would still land (and open its reading), and a
// second click queued behind it would then make a second reading and
// take a second weekly slot, with nothing on screen to say so. Without
// one, the button stays busy until the request settles, and a create that
// did land opens its reading.
//
// When it settles with no answer, the reading may or may not have been
// saved (a 504 can come after the commit), so a create says exactly that
// and asks to check the readings first (CREATE_NO_REPLY_MESSAGE, pending
// approval). An edit is safe to repeat, so it says "Something went wrong.
// Try again." A deploy since the page loaded means the action never ran:
// APP_UPDATED_MESSAGE.

import type { RejectionKind } from "./action-fallback";
import { APP_UPDATED_MESSAGE } from "./answer-form-state";
import type { ReadingFormState } from "./reading-form-state";
import { SUBMIT_FAILED_MESSAGE } from "@/lib/answer-check-guard";
import { CREATE_NO_REPLY_MESSAGE } from "@/lib/pending-copy";
import { readingFormInput, readingFormValues } from "@/lib/validate-reading";

export type ReadingFormMode = "create" | "edit" | "title" | "solo";

export function readingFormFallback(mode: ReadingFormMode, kind: RejectionKind, formData: FormData): ReadingFormState {
  const creates = mode === "create" || mode === "solo";
  const message = kind === "app_updated" ? APP_UPDATED_MESSAGE : creates ? CREATE_NO_REPLY_MESSAGE : SUBMIT_FAILED_MESSAGE;
  return { errors: { form: message }, values: readingFormValues(readingFormInput(formData)) };
}
