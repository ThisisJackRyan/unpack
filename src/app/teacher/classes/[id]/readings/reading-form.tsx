"use client";

import Link from "next/link";
import { useActionState } from "react";
import { GRADE_LEVELS, gradeLevelLabel } from "@/lib/grade-levels";
import {
  QUESTION_MODES,
  questionModeHint,
  questionModeLabel,
} from "@/lib/question-modes";
import { field, primaryButton, secondaryButton } from "@/components/ui";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  QUESTION_COUNT_DEFAULT,
  QUESTION_COUNT_MAX,
  QUESTION_COUNT_MIN,
  READING_TITLE_MAX_LENGTH,
  SOURCE_URL_MAX_LENGTH,
  type ReadingFormState,
  type ReadingFormValues,
} from "./form-state";

const label = "text-base font-semibold text-zinc-900";
const hint = "text-base text-zinc-600";
const errorText = "text-base text-red-700";

// A pill segmented control: a light gray track, the chosen option white.
// The radio inside each option is visually hidden but still focusable, so
// arrow keys move between options and the focus ring shows on the option.
const track = "grid gap-1 rounded-xl bg-zinc-100 p-1";
const option =
  "flex min-h-12 cursor-pointer rounded-lg px-4 text-zinc-600 transition-colors hover:text-zinc-950 has-checked:bg-white has-checked:text-zinc-950 has-checked:shadow-sm has-checked:ring-1 has-checked:ring-zinc-200 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-indigo-600";

const SOURCES = [
  { value: "link", label: "Paste a link" },
  { value: "text", label: "Paste text" },
] as const;

const QUESTION_COUNTS = Array.from(
  { length: QUESTION_COUNT_MAX - QUESTION_COUNT_MIN + 1 },
  (_, i) => QUESTION_COUNT_MIN + i,
);

const EMPTY_READING_VALUES: ReadingFormValues = {
  source: "link",
  url: "",
  title: "",
  bodyText: "",
  gradeLevel: "",
  questionCount: String(QUESTION_COUNT_DEFAULT),
  questionMode: "shared",
};

type Props = {
  action: (
    state: ReadingFormState,
    formData: FormData,
  ) => Promise<ReadingFormState>;
  // "create" offers link or text; "edit" edits the saved text directly.
  mode: "create" | "edit";
  classGradeLabel: string;
  cancelHref: string;
  initialValues?: ReadingFormValues;
  // Edit only: where the saved text came from.
  sourceHost?: string;
};

function describedBy(...ids: (string | false | undefined)[]) {
  return ids.filter(Boolean).join(" ") || undefined;
}

export function ReadingForm({
  action,
  mode,
  classGradeLabel,
  cancelHref,
  initialValues = EMPTY_READING_VALUES,
  sourceHost,
}: Props) {
  const [state, formAction, pending] = useActionState(action, {
    values: initialValues,
  });
  const values = state.values ?? initialValues;
  const errors = state.errors ?? {};
  const create = mode === "create";

  // In create mode the panels follow the checked source radio with CSS
  // (:has), so switching works before hydration and without JS.
  const linkPanel = "flex flex-col gap-2 group-has-[#source-text:checked]/form:hidden";
  const textPanel = create
    ? "hidden flex-col gap-2 group-has-[#source-text:checked]/form:flex"
    : "flex flex-col gap-2";
  const linkOnly = "group-has-[#source-text:checked]/form:hidden";

  return (
    <form action={formAction} noValidate className="group/form flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        {create && (
          <>
            <fieldset key={`source-${values.source}`} className="flex flex-col gap-2">
              <legend className={`${label} mb-2`}>Source</legend>
              <div className={`${track} grid-cols-2`}>
                {SOURCES.map((s) => (
                  <label
                    key={s.value}
                    className={`${option} items-center justify-center text-center text-base font-semibold`}
                  >
                    <input
                      type="radio"
                      id={`source-${s.value}`}
                      name="source"
                      value={s.value}
                      defaultChecked={values.source === s.value}
                      aria-describedby={errors.source ? "source-error" : undefined}
                      className="sr-only"
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <p id="source-error" aria-live="polite" className={`${errorText} empty:hidden`}>
                {errors.source}
              </p>
            </fieldset>

            <div className={linkPanel}>
              <label htmlFor="url" className={label}>
                Link
              </label>
              <input
                id="url"
                name="url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://"
                maxLength={SOURCE_URL_MAX_LENGTH}
                defaultValue={values.url}
                aria-invalid={errors.url ? true : undefined}
                aria-describedby={describedBy("url-hint", errors.url && "url-error")}
                className={field}
              />
              <p id="url-hint" className={hint}>
                We’ll pull the article text from the page.
              </p>
              <p id="url-error" aria-live="polite" className={`${errorText} empty:hidden`}>
                {errors.url}
                {errors.url && state.suggestText && (
                  <>
                    {" "}
                    <label
                      htmlFor="source-text"
                      className="cursor-pointer font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900"
                    >
                      {state.suggestText}
                    </label>
                  </>
                )}
              </p>
            </div>
          </>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="title" className={label}>
            Title
            {create && (
              <span className={`font-normal text-zinc-500 ${linkOnly}`}> (optional)</span>
            )}
          </label>
          <input
            id="title"
            name="title"
            type="text"
            autoComplete="off"
            maxLength={READING_TITLE_MAX_LENGTH}
            defaultValue={values.title}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={describedBy(create && "title-hint", errors.title && "title-error")}
            className={field}
          />
          {create && (
            <p id="title-hint" className={`${hint} ${linkOnly}`}>
              Leave blank to use the page’s title.
            </p>
          )}
          <p id="title-error" aria-live="polite" className={`${errorText} empty:hidden`}>
            {errors.title}
          </p>
        </div>

        <div className={textPanel}>
          <label htmlFor="bodyText" className={label}>
            {create ? "Reading text" : "Text"}
          </label>
          <textarea
            id="bodyText"
            name="bodyText"
            rows={14}
            defaultValue={values.bodyText}
            aria-invalid={errors.bodyText ? true : undefined}
            aria-describedby={describedBy("body-hint", errors.bodyText && "body-error")}
            className={`${field} min-h-72 py-3 text-base leading-relaxed`}
          />
          <p id="body-hint" className={hint}>
            {sourceHost && <>Saved from {sourceHost}. </>}
            At least {BODY_TEXT_MIN_LENGTH} characters, up to{" "}
            {BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")}.
          </p>
          <p id="body-error" aria-live="polite" className={`${errorText} empty:hidden`}>
            {errors.bodyText}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-6 border-t border-zinc-200 pt-8">
        <h2 className="text-lg font-semibold text-zinc-950">Questions</h2>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor="gradeLevel" className={label}>
              Grade level
            </label>
            <select
              id="gradeLevel"
              name="gradeLevel"
              // Remount on each result so the kept value is applied.
              key={`grade-${values.gradeLevel}`}
              defaultValue={values.gradeLevel}
              aria-invalid={errors.gradeLevel ? true : undefined}
              aria-describedby={errors.gradeLevel ? "grade-error" : undefined}
              className={field}
            >
              <option value="">Class grade ({classGradeLabel})</option>
              {GRADE_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {gradeLevelLabel(level)}
                </option>
              ))}
            </select>
            <p id="grade-error" aria-live="polite" className={`${errorText} empty:hidden`}>
              {errors.gradeLevel}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="questionCount" className={label}>
              Number of questions
            </label>
            <select
              id="questionCount"
              name="questionCount"
              key={`count-${values.questionCount}`}
              defaultValue={values.questionCount}
              aria-invalid={errors.questionCount ? true : undefined}
              aria-describedby={errors.questionCount ? "count-error" : undefined}
              className={field}
            >
              {QUESTION_COUNTS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
            <p id="count-error" aria-live="polite" className={`${errorText} empty:hidden`}>
              {errors.questionCount}
            </p>
          </div>
        </div>

        <fieldset key={`mode-${values.questionMode}`} className="flex flex-col gap-2">
          <legend className={`${label} mb-2`}>Question mode</legend>
          <div className={`${track} sm:grid-cols-2`}>
            {QUESTION_MODES.map((m) => (
              <label key={m} className={`${option} flex-col justify-center gap-0.5 py-3`}>
                <input
                  type="radio"
                  name="questionMode"
                  value={m}
                  defaultChecked={values.questionMode === m}
                  aria-describedby={describedBy(
                    `mode-${m}-hint`,
                    errors.questionMode && "mode-error",
                  )}
                  className="sr-only"
                />
                <span className="text-base font-semibold">{questionModeLabel(m)}</span>
                <span id={`mode-${m}-hint`} className="text-sm text-zinc-600">
                  {questionModeHint(m)}
                </span>
              </label>
            ))}
          </div>
          <p id="mode-error" aria-live="polite" className={`${errorText} empty:hidden`}>
            {errors.questionMode}
          </p>
        </fieldset>
      </div>

      <p aria-live="polite" className={`${errorText} empty:hidden`}>
        {errors.form}
      </p>

      <div className="flex flex-col-reverse gap-3 border-t border-zinc-200 pt-6 sm:flex-row sm:justify-end">
        <Link href={cancelHref} className={secondaryButton}>
          Cancel
        </Link>
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : create ? "Save draft" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
