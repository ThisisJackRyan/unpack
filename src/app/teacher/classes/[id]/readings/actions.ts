"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { guardCreate, readingSaveFailedState } from "@/lib/create-guard";
import { fetchArticle } from "@/lib/fetch-article";
import { linkFetchRetryAt, recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { LINK_FETCH_LIMITED_MESSAGE } from "@/lib/link-rate-limit";
import { withRetryAt } from "@/lib/local-time";
import { requestRetryClock } from "@/lib/request-time-zone";
import {
  getReadingForTeacher,
  insertReading,
  saveReadingEdit,
} from "@/lib/readings";
import { safeErrorFields, type SafeErrorFields } from "@/lib/safe-error-fields";
import { PUBLISHED_TITLE_ONLY_MESSAGE } from "@/lib/shared-questions";
import { getOrCreateTeacher } from "@/lib/teacher";
import { createTeacherReadingWith } from "@/lib/teacher-reading-create";
import { readingFormInput, readingFormValues, validateReadingForm } from "@/lib/validate-reading";
import type { ReadingFormState } from "@/components/reading-form-state";
import { GENERATE_FLAG } from "./[readingId]/question-state";

// Safe fields only (safe-error-fields.ts): a query error's message can
// echo the row, including the reading text.
function logDbError(where: string, fields: SafeErrorFields) {
  console.error(where, fields);
}

// Adds a draft reading to the class (see createTeacherReadingWith for the
// steps). Never throws, except Next's redirects: every other failure, a
// lookup past PRE_WRITE_DEADLINE_MS included, is
// SAVE_READING_FAILED_MESSAGE in the form, with everything typed still
// there (see create-guard.ts).
export async function createReading(
  classId: string,
  _prev: ReadingFormState,
  formData: FormData,
): Promise<ReadingFormState> {
  const input = readingFormInput(formData);
  const result = await guardCreate(
    (preWrite) =>
      createTeacherReadingWith(classId, input, preWrite, {
        requireTeacher: getOrCreateTeacher,
        ownsClass: async (id, teacherId) => !!(await getClassForTeacher(id, teacherId)),
        recordLinkFetch: (teacherId) => recordLinkFetchAttempt(teacherId),
        linkLimitedMessage: async (teacherId) =>
          withRetryAt(LINK_FETCH_LIMITED_MESSAGE, await linkFetchRetryAt(teacherId), await requestRetryClock()),
        fetchArticle: (url) => fetchArticle(url),
        insertReading: (id, teacherId, draft) => insertReading(id, teacherId, draft),
        log: (message, fields) => console.error(`createReading: ${message}`, fields),
      }),
    () => ({ state: readingSaveFailedState(readingFormValues(input)) }),
    {
      // getOrCreateTeacher's redirects are errors Next must handle.
      rethrow: unstable_rethrow,
      onError: (error) => console.error("createReading: create failed", safeErrorFields(error)),
    },
  );
  if ("state" in result) return result.state;

  // "Create & generate": the reading page starts writing the shared set
  // with the same action as its Generate button (same checks and limits).
  // A per-student reading has no set to write, so it just saves.
  const generate = formData.get("then") === "generate" && result.draft.questionMode === "shared";
  redirect(`/teacher/classes/${classId}/readings/${result.readingId}${generate ? `?${GENERATE_FLAG}=1` : ""}`);
}

export async function updateReading(
  classId: string,
  readingId: string,
  _prev: ReadingFormState,
  formData: FormData,
): Promise<ReadingFormState> {
  const teacher = await getOrCreateTeacher();
  let found: Awaited<ReturnType<typeof getReadingForTeacher>>;
  try {
    found = await getReadingForTeacher(classId, readingId, teacher.id);
  } catch (error) {
    logDbError("updateReading: getReadingForTeacher failed", safeErrorFields(error));
    return { errors: { form: "We couldn’t save your changes. Please try again." } };
  }
  if (!found) return { errors: { form: "We couldn’t find this reading." } };
  const { reading } = found;

  // A published reading's form sends only the title. Any field it leaves
  // out keeps its saved value; any field it does send must still match, or
  // the save is refused (see editReadingStatements).
  const published = reading.status === "published";
  const sent = (name: string, saved: string) =>
    published && !formData.has(name) ? saved : formData.get(name);

  // The edit form always edits the text directly.
  const result = validateReadingForm({
    source: "text",
    url: null,
    title: formData.get("title"),
    bodyText: sent("bodyText", reading.bodyText),
    gradeLevel: sent("gradeLevel", reading.gradeLevel ?? ""),
    questionCount: sent("questionCount", String(reading.questionCount)),
    questionMode: sent("questionMode", reading.questionMode),
  });
  if (!result.ok) {
    return { errors: result.errors, values: result.values };
  }
  const { data, values } = result;
  if (data.source !== "text") throw new Error("unreachable");

  try {
    const saved = await saveReadingEdit(classId, readingId, teacher.id, {
      title: data.title,
      // The saved text as is, not re-normalized, when the form didn't send it.
      bodyText: published && !formData.has("bodyText") ? reading.bodyText : data.bodyText,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
      questionMode: data.questionMode,
    });
    if (!saved) {
      // Published (perhaps since the page loaded) and more than the title
      // changed, or the reading is gone.
      const again = await getReadingForTeacher(classId, readingId, teacher.id);
      return {
        errors: {
          // Only blame publishing when the reading really is published now.
          form: !again
            ? "We couldn’t find this reading."
            : again.reading.status === "published"
              ? PUBLISHED_TITLE_ONLY_MESSAGE
              : "We couldn’t save your changes. Please try again.",
        },
        values,
      };
    }
  } catch (error) {
    logDbError("updateReading: saveReadingEdit failed", safeErrorFields(error));
    return {
      errors: { form: "We couldn’t save your changes. Please try again." },
      values,
    };
  }

  redirect(`/teacher/classes/${classId}/readings/${readingId}`);
}
