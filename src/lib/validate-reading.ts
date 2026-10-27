import { isGradeLevel, type GradeLevel } from "./grade-levels";
import { isQuestionMode, type QuestionMode } from "./question-modes";

// Pure validation for the add and edit reading forms, shared by the server
// actions, the article extractor, and tests. Safe to import from client code.

export const READING_TITLE_MAX_LENGTH = 120;

// The spec sets no limits on reading length. These are ours, counted after
// normalizeBodyText: under 200 characters there is too little to ask about,
// and 20,000 (roughly 3,000 to 4,000 words, a long article) keeps pages and
// question prompts a sensible size.
export const BODY_TEXT_MIN_LENGTH = 200;
export const BODY_TEXT_MAX_LENGTH = 20_000;

// Shown by the server and, before submitting, by the form's counter check.
export const BODY_TEXT_TOO_LONG_MESSAGE = `This is too long. Keep it under ${BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")} characters, or paste a shorter section.`;

export const SOURCE_URL_MAX_LENGTH = 2048;

export const QUESTION_COUNT_MIN = 1;
export const QUESTION_COUNT_MAX = 10;
export const QUESTION_COUNT_DEFAULT = 3;

export const READING_SOURCES = ["link", "text"] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

// What the form shows again after an error, as typed (only trimmed).
export type ReadingFormValues = {
  source: string;
  url: string;
  title: string;
  bodyText: string;
  gradeLevel: string;
  questionCount: string;
  questionMode: string;
};

export type ReadingFormErrors = {
  source?: string;
  url?: string;
  title?: string;
  bodyText?: string;
  gradeLevel?: string;
  questionCount?: string;
  questionMode?: string;
};

// Fields every reading has, whatever the source.
export type ReadingSettings = {
  gradeLevel: GradeLevel | null;
  questionCount: number;
  questionMode: QuestionMode;
};

export type ReadingFormData =
  | (ReadingSettings & {
      source: "link";
      url: string;
      // Empty when the teacher left it blank; filled from the page later.
      title: string;
    })
  | (ReadingSettings & {
      source: "text";
      title: string;
      bodyText: string;
    });

export type ReadingFormValidation =
  | { ok: true; data: ReadingFormData; values: ReadingFormValues }
  | { ok: false; errors: ReadingFormErrors; values: ReadingFormValues };

// Control characters other than tab and newline, including C1 controls.
// Carriage returns are turned into newlines before this runs.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

// Normalizes reading text from a paste or a web page: CRLF and CR become LF,
// Unicode line and paragraph separators become LF, control characters
// (NUL included) are removed except tab and newline, trailing spaces on each
// line are dropped, 3 or more newlines collapse to a blank line, and the
// whole text is trimmed.
export function normalizeBodyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Titles are one line: any run of whitespace becomes one space.
export function normalizeTitle(title: string): string {
  return title.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

// Shortens a title found on a web page to the max length, at a word break
// when there is one near the end, with an ellipsis.
export function cutTitle(title: string): string {
  const clean = normalizeTitle(title);
  if (clean.length <= READING_TITLE_MAX_LENGTH) return clean;
  let cut = clean.slice(0, READING_TITLE_MAX_LENGTH - 1);
  // Don't leave half of a surrogate pair (an emoji, say) at the end.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(" ");
  if (space >= READING_TITLE_MAX_LENGTH - 30) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

// The title for a reading added by link: the one the teacher typed, or else
// the page's title. Undefined when neither has any text.
export function resolveLinkTitle(
  typed: string,
  extracted: string | null | undefined,
): string | undefined {
  const own = normalizeTitle(typed);
  if (own) return own;
  const fromPage = cutTitle(extracted ?? "");
  return fromPage || undefined;
}

// Turns what the teacher typed into an absolute http(s) URL string, adding
// https:// when there is no scheme ("example.com/story"). Returns undefined
// when it isn't a usable web link. Private hosts are checked later, on the
// server, by url-guard.
export function parseSourceUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > SOURCE_URL_MAX_LENGTH) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  return url.href;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bodyTextError(text: string): string | undefined {
  if (!text) return "Paste the text of the reading.";
  if (text.length < BODY_TEXT_MIN_LENGTH) {
    return `This is too short. Paste at least ${BODY_TEXT_MIN_LENGTH} characters.`;
  }
  if (text.length > BODY_TEXT_MAX_LENGTH) {
    return BODY_TEXT_TOO_LONG_MESSAGE;
  }
  return undefined;
}

// Takes raw FormData values. The edit form has no source choice: it always
// edits the text directly, so pass source "text".
//
// Only the chosen source's field is read: in link mode the text box is
// ignored, and in text mode the link is ignored.
export function validateReadingForm(input: {
  source: unknown;
  url: unknown;
  title: unknown;
  bodyText: unknown;
  gradeLevel: unknown;
  questionCount: unknown;
  questionMode: unknown;
}): ReadingFormValidation {
  const values: ReadingFormValues = {
    source: asString(input.source),
    url: asString(input.url).trim(),
    title: asString(input.title).trim(),
    bodyText: asString(input.bodyText),
    gradeLevel: asString(input.gradeLevel),
    questionCount: asString(input.questionCount),
    questionMode: asString(input.questionMode),
  };
  const errors: ReadingFormErrors = {};

  const source = values.source;
  if (source !== "link" && source !== "text") {
    errors.source = "Choose a link or text.";
  }

  let url: string | undefined;
  if (source === "link") {
    url = parseSourceUrl(values.url);
    if (!values.url) {
      errors.url = "Paste a link to the reading.";
    } else if (!url) {
      errors.url = "Enter a full web link, like https://example.com/story.";
    }
  }

  const title = normalizeTitle(values.title);
  if (source === "text" && !title) {
    errors.title = "Enter a title.";
  } else if (title.length > READING_TITLE_MAX_LENGTH) {
    errors.title = `Keep the title to ${READING_TITLE_MAX_LENGTH} characters or less.`;
  }

  let bodyText = "";
  if (source === "text") {
    bodyText = normalizeBodyText(values.bodyText);
    const error = bodyTextError(bodyText);
    if (error) errors.bodyText = error;
  }

  const gradeLevel = values.gradeLevel === "" ? null : values.gradeLevel;
  if (gradeLevel !== null && !isGradeLevel(gradeLevel)) {
    errors.gradeLevel = "Choose a grade level.";
  }

  const questionCount = /^\d{1,2}$/.test(values.questionCount)
    ? Number(values.questionCount)
    : NaN;
  if (
    !(questionCount >= QUESTION_COUNT_MIN && questionCount <= QUESTION_COUNT_MAX)
  ) {
    errors.questionCount = `Choose ${QUESTION_COUNT_MIN} to ${QUESTION_COUNT_MAX} questions.`;
  }

  if (!isQuestionMode(values.questionMode)) {
    errors.questionMode = "Choose how questions are made.";
  }

  if (
    Object.keys(errors).length > 0 ||
    (gradeLevel !== null && !isGradeLevel(gradeLevel)) ||
    !isQuestionMode(values.questionMode)
  ) {
    return { ok: false, errors, values };
  }

  const settings: ReadingSettings = {
    gradeLevel,
    questionCount,
    questionMode: values.questionMode,
  };
  const data: ReadingFormData =
    source === "link"
      ? { ...settings, source, url: url!, title }
      : { ...settings, source: "text", title, bodyText };
  return { ok: true, data, values };
}

// The host to show for a saved source link, without "www.". Undefined when
// the link is missing or can't be parsed.
export function sourceHost(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}
