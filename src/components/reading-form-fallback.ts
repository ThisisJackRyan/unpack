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
// and asks to check the readings first (CREATE_NO_REPLY_MESSAGE, with
// "Check your readings" a link to the list: noReplyParts). An edit is safe to repeat, so it says "Something went wrong.
// Try again." A deploy since the page loaded means the action never ran:
// APP_UPDATED_MESSAGE.

import type { RejectionKind } from "./action-fallback";
import { APP_UPDATED_MESSAGE } from "./answer-form-state";
import { CREATE_NO_REPLY_MESSAGE, type ReadingFormState } from "./reading-form-state";
import { SUBMIT_FAILED_MESSAGE } from "@/lib/answer-check-guard";
import { readingFormInput, readingFormValues } from "@/lib/validate-reading";

export type ReadingFormMode = "create" | "edit" | "title" | "solo";

export function readingFormFallback(mode: ReadingFormMode, kind: RejectionKind, formData: FormData): ReadingFormState {
  const creates = mode === "create" || mode === "solo";
  const message = kind === "app_updated" ? APP_UPDATED_MESSAGE : creates ? CREATE_NO_REPLY_MESSAGE : SUBMIT_FAILED_MESSAGE;
  return { errors: { form: message }, values: readingFormValues(readingFormInput(formData)) };
}

// Where a create's readings are listed: a self-learner's on /learn, a
// teacher's on the class page. Null for an edit (no no-reply link there).
export function readingsListHref(mode: ReadingFormMode, classId?: string): string | null {
  if (mode === "solo") return "/learn";
  if (mode === "create" && classId) return `/teacher/classes/${classId}`;
  return null;
}

export const CHECK_READINGS_LINK_TEXT = "Check your readings";

export type NoReplyParts = { before: string; linkText: string; after: string; href: string };

// The form error stays a plain string; at display time the no-reply message
// is split around "Check your readings" so those words can be a link. The
// three parts joined are the message, word for word. Null for any other
// message, or with nowhere to link.
export function noReplyParts(message: string | undefined, href: string | null): NoReplyParts | null {
  if (message !== CREATE_NO_REPLY_MESSAGE || !href) return null;
  const at = message.indexOf(CHECK_READINGS_LINK_TEXT);
  if (at < 0) return null;
  return {
    before: message.slice(0, at),
    linkText: CHECK_READINGS_LINK_TEXT,
    after: message.slice(at + CHECK_READINGS_LINK_TEXT.length),
    href,
  };
}
