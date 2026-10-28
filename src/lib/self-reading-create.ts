// The self-learner's new reading (/learn/new), as a flow over injected
// dependencies, so tests run every failure with fakes (the action in
// src/app/learn/new/actions.ts binds the real ones and runs this inside
// guardCreate). The teacher form's validation and link reading
// (resolveReadingSource, with the account's link fetch limit), then the
// insert under the weekly allowance.
//
// The weekly slot is the self_readings row itself (heldSlotsSql in
// self-allowance.ts), inserted and counted in ONE transaction, so a slot
// is used by a committed reading and nothing else: every failure before
// that transaction (a lookup that throws or passes the deadline, a link
// that can't be read) and a transaction that fails leave the allowance as
// it was. self-reading-create.test.ts and scripts/check-self-learner.ts
// show it.

import type { ReadingFormState } from "@/components/reading-form-state";
import { withDeadline } from "./deadline";
import { readingSaveFailedState, safeErrorFields } from "./create-guard";
import { resolveReadingSource } from "./reading-source";
import { createOutcomeRedirect, type CreateOutcome, type CreateRedirect, type SelfReadingDraft } from "./self-allowance";
import { validateSoloReadingForm } from "./self-reading-form";
import type { ReadingFormInput } from "./validate-reading";

export type SelfCreateDeps = {
  // requireSelfLearner: may redirect (signed out, not a self-learner).
  requireAccount: () => Promise<{ id: string }>;
  getAllowance: (accountId: string) => Promise<{ remaining: number }>;
  // A write (link_fetch_attempts), so never cut by the deadline.
  recordLinkFetch: (accountId: string) => Promise<boolean>;
  // The note at the link limit, with its retry time (a read).
  linkLimitedMessage: (accountId: string) => Promise<string>;
  fetchArticle: (url: string) => Promise<{ title: string; text: string; url: string }>;
  // The create transaction: the insert and the slot count together.
  createSelfReading: (accountId: string, draft: SelfReadingDraft) => Promise<CreateOutcome>;
  // Safe fields only.
  log: (message: string, fields: Record<string, unknown>) => void;
};

export type SelfCreateResult = { state: ReadingFormState } | { redirect: CreateRedirect };

// At the allowance, /learn/new itself shows the calm limit note, so the
// form goes back there (a replace, as every redirect here).
const AT_LIMIT: CreateRedirect = { path: "/learn/new", type: "replace" };

export async function createSelfReadingWith(
  input: ReadingFormInput,
  preWrite: AbortSignal,
  deps: SelfCreateDeps,
): Promise<SelfCreateResult> {
  // Its redirects come through the deadline as they are.
  const account = await withDeadline(deps.requireAccount(), preWrite);
  const result = validateSoloReadingForm(input);
  if (!result.ok) return { state: { errors: result.errors, values: result.values } };
  const { data, values } = result;

  // Before fetching anything: no link fetch for a reading that can't be
  // saved. The insert checks again under the lock.
  const { remaining } = await withDeadline(deps.getAllowance(account.id), preWrite);
  if (remaining === 0) return { redirect: AT_LIMIT };

  // For a link, the link_fetch_attempts row is written before the fetch,
  // whatever happens next: it limits fetches (each one costs us a request
  // to someone's server), not readings, so a fetch for a create that then
  // fails still counts. Pasted text writes nothing here.
  const resolved = await resolveReadingSource(data, {
    recordLinkFetch: () => deps.recordLinkFetch(account.id),
    limitedMessage: () => withDeadline(deps.linkLimitedMessage(account.id), preWrite),
    fetchArticle: (url) => deps.fetchArticle(url),
    log: (message, fields) => deps.log(message, fields),
  });
  if (!resolved.ok) return { state: { errors: resolved.errors, values, suggestText: resolved.suggestText, limit: resolved.limit } };

  // The first write that uses a slot. Not bounded: see create-guard.ts.
  let outcome: CreateOutcome;
  try {
    outcome = await deps.createSelfReading(account.id, {
      ...resolved.source,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
    });
  } catch (error) {
    deps.log("createSelfReading failed", safeErrorFields(error));
    return { state: readingSaveFailedState(values) };
  }
  return { redirect: createOutcomeRedirect(outcome) };
}
