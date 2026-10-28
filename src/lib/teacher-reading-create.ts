// A teacher's new reading, as a flow over injected dependencies, so tests
// run every failure with fakes (the action in
// src/app/teacher/classes/[id]/readings/actions.ts binds the real ones
// and runs this inside guardCreate). Validation, the class ownership
// check, the link reading (resolveReadingSource, with the teacher's link
// fetch limit), then one insert. A failure anywhere before the insert, or
// an insert that fails, writes no reading (teacher-reading-create.test.ts).

import type { ReadingFormState } from "@/components/reading-form-state";
import { readingSaveFailedState, safeErrorFields } from "./create-guard";
import { withDeadline } from "./deadline";
import { resolveReadingSource } from "./reading-source";
import type { ReadingDraft } from "./readings";
import { validateReadingForm, type ReadingFormInput } from "./validate-reading";

export const CLASS_NOT_FOUND_MESSAGE = "We couldn’t find this class.";

export type TeacherCreateDeps = {
  // getOrCreateTeacher: may redirect (signed out, not a teacher).
  requireTeacher: () => Promise<{ id: string }>;
  ownsClass: (classId: string, teacherId: string) => Promise<boolean>;
  // A write (link_fetch_attempts), so never cut by the deadline.
  recordLinkFetch: (teacherId: string) => Promise<boolean>;
  // The note at the link limit, with its retry time (a read).
  linkLimitedMessage: (teacherId: string) => Promise<string>;
  fetchArticle: (url: string) => Promise<{ title: string; text: string; url: string }>;
  // The one write that makes the reading (undefined: not this teacher's
  // class, nothing inserted).
  insertReading: (classId: string, teacherId: string, draft: ReadingDraft) => Promise<{ id: string } | undefined>;
  // Safe fields only.
  log: (message: string, fields: Record<string, unknown>) => void;
};

export type TeacherCreateResult = { state: ReadingFormState } | { readingId: string; draft: ReadingDraft };

export async function createTeacherReadingWith(
  classId: string,
  input: ReadingFormInput,
  preWrite: AbortSignal,
  deps: TeacherCreateDeps,
): Promise<TeacherCreateResult> {
  const result = validateReadingForm(input);
  if (!result.ok) return { state: { errors: result.errors, values: result.values } };
  const { data, values } = result;

  // Check ownership before fetching anything. Its redirects come through
  // the deadline as they are.
  const teacher = await withDeadline(deps.requireTeacher(), preWrite);
  if (!(await withDeadline(deps.ownsClass(classId, teacher.id), preWrite))) {
    return { state: { errors: { form: CLASS_NOT_FOUND_MESSAGE }, values } };
  }

  // For a link, the link_fetch_attempts row is written before the fetch,
  // whatever happens next: it limits fetches, not readings.
  const resolved = await resolveReadingSource(data, {
    recordLinkFetch: () => deps.recordLinkFetch(teacher.id),
    limitedMessage: () => withDeadline(deps.linkLimitedMessage(teacher.id), preWrite),
    fetchArticle: (url) => deps.fetchArticle(url),
    log: (message, fields) => deps.log(message, fields),
  });
  if (!resolved.ok) {
    return { state: { errors: resolved.errors, values, suggestText: resolved.suggestText, limit: resolved.limit } };
  }
  const draft: ReadingDraft = {
    ...resolved.source,
    gradeLevel: data.gradeLevel,
    questionCount: data.questionCount,
    questionMode: data.questionMode,
  };

  // The first write. Not bounded: see create-guard.ts.
  let created: { id: string } | undefined;
  try {
    created = await deps.insertReading(classId, teacher.id, draft);
  } catch (error) {
    deps.log("insertReading failed", safeErrorFields(error));
    return { state: readingSaveFailedState(values) };
  }
  if (!created) return { state: { errors: { form: CLASS_NOT_FOUND_MESSAGE }, values } };
  return { readingId: created.id, draft };
}
