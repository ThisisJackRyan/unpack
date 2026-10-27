"use server";

import { redirect } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { fetchArticle } from "@/lib/fetch-article";
import { FetchArticleError, type FetchArticleErrorKind } from "@/lib/fetch-errors";
import { recordLinkFetchAttempt } from "@/lib/link-fetch-attempts";
import { LINK_FETCH_LIMITED_MESSAGE } from "@/lib/link-rate-limit";
import {
  getReadingForTeacher,
  insertReading,
  saveReadingEdit,
  type ReadingDraft,
} from "@/lib/readings";
import { PUBLISHED_TITLE_ONLY_MESSAGE } from "@/lib/shared-questions";
import { getOrCreateTeacher } from "@/lib/teacher";
import {
  BODY_TEXT_MAX_LENGTH,
  resolveLinkTitle,
  validateReadingForm,
} from "@/lib/validate-reading";
import type { ReadingFormState } from "./form-state";

const LINK_ERRORS: Record<FetchArticleErrorKind, string> = {
  invalid_url: "Enter a full web link, like https://example.com/story.",
  blocked: "We can’t open that link.",
  timeout: "That page took too long to load.",
  too_large: "That page is too big for us to read.",
  not_html: "That link isn’t a web page. It may be a PDF or other file.",
  http_error: "We couldn’t open that page.",
  extract_failed: "We couldn’t find the article text on that page.",
  too_long: `That article is over ${BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters.`,
};

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

  let draft: ReadingDraft;
  if (data.source === "link") {
    // Counts this attempt, before fetching, whatever the fetch's outcome.
    // Fails closed: if we can't check the limit, we don't fetch.
    let allowed: boolean;
    try {
      allowed = await recordLinkFetchAttempt(teacher.id);
    } catch (error) {
      logDbError("createReading: recordLinkFetchAttempt failed", error);
      return {
        errors: { form: "We couldn’t save the reading. Please try again." },
        values,
      };
    }
    if (!allowed) {
      return {
        errors: { url: LINK_FETCH_LIMITED_MESSAGE },
        values,
        // Pasted text isn't limited.
        suggestText: "Paste the text instead.",
      };
    }

    let article: Awaited<ReturnType<typeof fetchArticle>>;
    try {
      article = await fetchArticle(data.url);
    } catch (error) {
      const kind = error instanceof FetchArticleError ? error.kind : "http_error";
      // Kind and host only: no full URL (query strings), IPs, or stacks.
      console.error("createReading: fetchArticle failed", {
        kind,
        host: error instanceof FetchArticleError ? error.host : undefined,
        name: error instanceof Error ? error.name : typeof error,
      });
      return {
        errors: { url: LINK_ERRORS[kind] },
        values,
        suggestText:
          kind === "invalid_url"
            ? undefined
            : kind === "too_long"
              ? "Paste a shorter section instead."
              : "Paste the text instead.",
      };
    }
    const title = resolveLinkTitle(data.title, article.title);
    if (!title) {
      return {
        errors: { title: "We couldn’t find a title on that page. Please add one." },
        values,
      };
    }
    draft = {
      title,
      bodyText: article.text,
      // Where the text really came from, after any redirects.
      sourceUrl: article.url,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
      questionMode: data.questionMode,
    };
  } else {
    draft = {
      title: data.title,
      bodyText: data.bodyText,
      sourceUrl: null,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
      questionMode: data.questionMode,
    };
  }

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
      errors: { form: "We couldn’t save the reading. Please try again." },
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
