"use server";

import { redirect } from "next/navigation";
import { getClassForTeacher } from "@/lib/classes";
import { fetchArticle } from "@/lib/fetch-article";
import { FetchArticleError, type FetchArticleErrorKind } from "@/lib/fetch-errors";
import { insertReading, updateDraftReading, type ReadingDraft } from "@/lib/readings";
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
  // The edit form always edits the text directly.
  const result = readForm(formData, "text");
  if (!result.ok) {
    return { errors: result.errors, values: result.values };
  }
  const { data, values } = result;
  if (data.source !== "text") throw new Error("unreachable");

  const teacher = await getOrCreateTeacher();
  try {
    const updated = await updateDraftReading(classId, readingId, teacher.id, {
      title: data.title,
      bodyText: data.bodyText,
      gradeLevel: data.gradeLevel,
      questionCount: data.questionCount,
      questionMode: data.questionMode,
    });
    if (!updated) {
      return {
        errors: { form: "Only drafts can be edited." },
        values,
      };
    }
  } catch (error) {
    logDbError("updateReading: updateDraftReading failed", error);
    return {
      errors: { form: "We couldn’t save your changes. Please try again." },
      values,
    };
  }

  redirect(`/teacher/classes/${classId}/readings/${readingId}`);
}
