"use server";

import { redirect } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { fetchArticle } from "@/lib/fetch-article";
import { recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { resolveReadingSource, SAVE_READING_FAILED_MESSAGE } from "@/lib/reading-source";
import {
  getReadingForTeacher,
  insertReading,
  saveReadingEdit,
  type ReadingDraft,
} from "@/lib/readings";
import { PUBLISHED_TITLE_ONLY_MESSAGE } from "@/lib/shared-questions";
import { getOrCreateTeacher } from "@/lib/teacher";
import { validateReadingForm } from "@/lib/validate-reading";
import type { ReadingFormState } from "./form-state";

function readForm(formData: FormData, source: unknown) {
  return validateReadingForm({
    source,
    url: formData.get("url"),
    title: formData.get("title"),
    bodyText: formData.get("bodyText"),
    gradeLevel: formData.get("gradeLevel"),
    questionCount: formData.get("questionCount"),
    questionMode: formData.get("questionMode"),
  });
}

// Name, code, and message only: a Postgres error's detail can echo the row,
// including the reading text.
function logDbError(where: string, error: unknown) {
  const { name, code, message } = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  console.error(where, { name, code, message });
}

export async function createReading(
  classId: string,
  _prev: ReadingFormState,
  formData: FormData,
): Promise<ReadingFormState> {
  const result = readForm(formData, formData.get("source"));
  if (!result.ok) {
    return { errors: result.errors, values: result.values };
  }
  const { data, values } = result;

  // Check ownership before fetching anything.
  const teacher = await getOrCreateTeacher();
  if (!(await getClassForTeacher(classId, teacher.id))) {
    return { errors: { form: "We couldn’t find this class." }, values };
  }

  const resolved = await resolveReadingSource(data, {
    recordLinkFetch: () => recordLinkFetchAttempt(teacher.id),
    fetchArticle: (url) => fetchArticle(url),
    log: (message, fields) => console.error(`createReading: ${message}`, fields),
  });
  if (!resolved.ok) {
    return { errors: resolved.errors, values, suggestText: resolved.suggestText };
  }
  const draft: ReadingDraft = {
    ...resolved.source,
    gradeLevel: data.gradeLevel,
    questionCount: data.questionCount,
    questionMode: data.questionMode,
  };

  // redirect() throws, so it stays outside this try.
  let readingId: string;
  try {
    const created = await insertReading(classId, teacher.id, draft);
    if (!created) {
      return { errors: { form: "We couldn’t find this class." }, values };
    }
    readingId = created.id;
  } catch (error) {
    logDbError("createReading: insertReading failed", error);
    return {
      errors: { form: SAVE_READING_FAILED_MESSAGE },
      values,
    };
  }

  redirect(`/teacher/classes/${classId}/readings/${readingId}`);
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
    logDbError("updateReading: getReadingForTeacher failed", error);
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
    logDbError("updateReading: saveReadingEdit failed", error);
    return {
      errors: { form: "We couldn’t save your changes. Please try again." },
      values,
    };
  }

  redirect(`/teacher/classes/${classId}/readings/${readingId}`);
}
