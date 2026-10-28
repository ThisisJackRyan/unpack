"use client";

import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { useActionState, useMemo, useRef, useState, type FormEvent } from "react";
import { GRADE_LEVELS, gradeLevelLabel } from "@/lib/grade-levels";
import {
  QUESTION_MODES,
  questionModeHint,
  questionModeLabel,
} from "@/lib/question-modes";
import { ErrorMessage } from "@/components/error-message";
import { LimitNotice } from "@/components/limit-notice";
import { MaxLengthNote } from "@/components/max-length-note";
import { withRejectionFallback } from "@/components/action-fallback";
import { readingFormFallback } from "@/components/reading-form-fallback";
import { field, optionCard, optionRadio, primaryButton, quietButton, secondaryButton } from "@/components/ui";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  BODY_TEXT_TOO_LONG_MESSAGE,
  normalizeBodyText,
  QUESTION_COUNT_DEFAULT,
  QUESTION_COUNT_MAX,
  QUESTION_COUNT_MIN,
  READING_TITLE_MAX_LENGTH,
  SOURCE_URL_MAX_LENGTH,
  type ReadingFormState,
  type ReadingFormValues,
} from "./reading-form-state";

const label = "text-lg font-semibold text-ink-950";
const hint = "text-lg text-ink-700";

// Radio choices are cards side by side (optionCard in ui.ts): a visible
// native radio, the chosen card tinted. Arrow keys move between options.
const cards = "grid gap-3";

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
  // "create" offers link or text; "edit" edits the saved text directly;
  // "title" (a published reading) shows only the title. "solo" is the
  // self-learner's new reading: link or text, a reading level they must
  // choose (no class grade), the number of questions, and no question mode
  // (a self-learner's questions are always their own).
  mode: "create" | "edit" | "title" | "solo";
  // The class grade, for the "Class grade" option (not in solo mode).
  classGradeLabel?: string;
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
  // A request that fails outright (no answer, a 504, a lapsed session, a
  // deploy) is a message in this form with every value kept, never the
  // page's error boundary (see reading-form-fallback.ts, which also says
  // why there is no client time limit here).
  const guarded = useMemo(
    () => withRejectionFallback(action, (kind, formData) => readingFormFallback(mode, kind, formData), unstable_rethrow),
    [action, mode],
  );
  const [state, formAction, pending] = useActionState(guarded, {
    values: initialValues,
  });
  const values = state.values ?? initialValues;
  const errors = state.errors ?? {};
  const solo = mode === "solo";
  const create = mode === "create" || solo;
  const titleOnly = mode === "title";

  // The panels switch with CSS alone; this mirrors the checked source radio
  // for the pending label and the length check.
  const [source, setSource] = useState(create ? values.source : "text");
  const textMode = source === "text";

  // Counted after the same normalizing the server does, so the number
  // matches the server's limit check.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [bodyLength, setBodyLength] = useState(
    () => normalizeBodyText(values.bodyText).length,
  );
  const [tooLong, setTooLong] = useState(false);
  // Which create button was pressed ("save" or "generate"), for its
  // pending label.
  const [then, setThen] = useState("save");
  const overLimit = bodyLength > BODY_TEXT_MAX_LENGTH;
  const bodyError = (tooLong && overLimit && BODY_TEXT_TOO_LONG_MESSAGE) || errors.bodyText;

  // Stops a submit the server would reject for length, before uploading a
  // large paste. Link mode ignores the text box, so it never blocks there.
  // Reads the live form, in case the radio or text changed before hydration.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const submitted = create ? String(data.get("source") ?? "") : "text";
    const length = normalizeBodyText(String(data.get("bodyText") ?? "")).length;
    setSource(submitted);
    setBodyLength(length);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    setThen(submitter instanceof HTMLButtonElement ? submitter.value : "save");
    if (submitted === "text" && length > BODY_TEXT_MAX_LENGTH) {
      event.preventDefault();
      setTooLong(true);
      textareaRef.current?.focus();
    }
  }

  // In create mode the panels follow the checked source radio with CSS
  // (:has), so switching works before hydration and without JS.
  const linkPanel = "flex flex-col gap-2 group-has-[#source-text:checked]/form:hidden";
  const textPanel = create
    ? "hidden flex-col gap-2 group-has-[#source-text:checked]/form:flex"
    : "flex flex-col gap-2";
  const linkOnly = "group-has-[#source-text:checked]/form:hidden";
  // A teacher's new reading: "Create & generate" (save, then write the
  // shared set on the reading page) with a quieter "Save draft" (a text
  // style button) beside it. A
  // per-student reading has no set to write, so "Save draft" is the main
  // button there. CSS follows the checked mode radio, like the panels.
  const sharedOnly = "group-has-[#mode-per_student:checked]/form:hidden";
  const perStudentPrimary = primaryButton.replace(
    "inline-flex",
    "hidden group-has-[#mode-per_student:checked]/form:inline-flex",
  );
  const teacherCreate = mode === "create";
  const pendingLabel = create && !textMode ? "Getting the article…" : "Saving…";

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      className="group/form flex flex-col gap-8"
    >
      <div className="flex flex-col gap-6">
        {create && (
          <>
            <fieldset key={`source-${values.source}`} className="flex flex-col gap-2">
              <legend className={`${label} mb-2`}>Source</legend>
              <div className={`${cards} sm:grid-cols-2`}>
                {SOURCES.map((s) => (
                  <label key={s.value} className={`${optionCard} items-center text-lg font-semibold`}>
                    <input
                      type="radio"
                      id={`source-${s.value}`}
                      name="source"
                      value={s.value}
                      defaultChecked={values.source === s.value}
                      onChange={(e) => setSource(e.currentTarget.value)}
                      aria-describedby={errors.source ? "source-error" : undefined}
                      className={optionRadio}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <ErrorMessage id="source-error">
                {errors.source}
              </ErrorMessage>
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
                className={`${field} text-lg`}
              />
              <p id="url-hint" className={hint}>
                We’ll pull the article text from the page.
              </p>
              <ErrorMessage id="url-error">
                {errors.url}
                {errors.url && state.suggestText && (
                  <>
                    {" "}
                    <label
                      htmlFor="source-text"
                      className="cursor-pointer font-semibold text-primary-700 underline underline-offset-2 hover:text-primary-900"
                    >
                      {state.suggestText}
                    </label>
                  </>
                )}
              </ErrorMessage>
              {state.limit && (
                <LimitNotice>
                  {state.limit}
                  {state.suggestText && (
                    <>
                      {" "}
                      <label
                        htmlFor="source-text"
                        className="cursor-pointer font-semibold text-primary-800 underline underline-offset-2 hover:text-primary-950"
                      >
                        {state.suggestText}
                      </label>
                    </>
                  )}
                </LimitNotice>
              )}
            </div>
          </>
        )}

        <div className="flex flex-col gap-2">
          <label htmlFor="title" className={label}>
            Title
            {create && (
              <span className={`font-normal text-ink-700 ${linkOnly}`}> (optional)</span>
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
            className={`${field} text-lg`}
          />
          {create && (
            <p id="title-hint" className={`${hint} ${linkOnly}`}>
              Leave blank to use the page’s title.
            </p>
          )}
          <ErrorMessage id="title-error">
            {errors.title}
          </ErrorMessage>
        </div>

        {!titleOnly && (
          <div className={textPanel}>
            <label htmlFor="bodyText" className={label}>
              {create ? "Reading text" : "Text"}
            </label>
            <textarea
              ref={textareaRef}
              id="bodyText"
              name="bodyText"
              rows={14}
              defaultValue={values.bodyText}
              onChange={(e) =>
                setBodyLength(normalizeBodyText(e.currentTarget.value).length)
              }
              aria-invalid={bodyError ? true : undefined}
              aria-describedby={describedBy(
                "body-hint",
                "body-count",
                bodyError && "body-error",
              )}
              className={`${field} min-h-72 py-3 text-lg leading-relaxed`}
            />
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
              <p id="body-hint" className={hint}>
                {sourceHost && <>Saved from {sourceHost}. </>}
                At least {BODY_TEXT_MIN_LENGTH} characters, up to{" "}
                {BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")}.
              </p>
              <p
                id="body-count"
                aria-live="polite"
                className={`text-lg tabular-nums ${overLimit ? "font-semibold text-danger-700" : "text-ink-700"}`}
              >
                {bodyLength.toLocaleString("en-US")} /{" "}
                {BODY_TEXT_MAX_LENGTH.toLocaleString("en-US")}
                <span className="sr-only"> characters</span>
              </p>
              <MaxLengthNote id="body-max" length={bodyLength} max={BODY_TEXT_MAX_LENGTH} large={false} />
            </div>
            <ErrorMessage id="body-error">
              {bodyError}
            </ErrorMessage>
          </div>
        )}
      </div>

      {!titleOnly && (
        <div className="flex flex-col gap-6 border-t border-ink-200 pt-8">
          <h2 className="text-lg font-semibold text-ink-950">Questions</h2>

          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <label htmlFor="gradeLevel" className={label}>
                {solo ? "Reading level" : "Grade level"}
              </label>
              <select
                id="gradeLevel"
                name="gradeLevel"
                // Remount on each result so the kept value is applied.
                key={`grade-${values.gradeLevel}`}
                defaultValue={values.gradeLevel}
                aria-invalid={errors.gradeLevel ? true : undefined}
                aria-describedby={describedBy(solo && "grade-hint", errors.gradeLevel && "grade-error")}
                className={`${field} text-lg`}
              >
                {solo ? (
                  <option value="" disabled>
                    Choose a level
                  </option>
                ) : (
                  <option value="">Class grade ({classGradeLabel})</option>
                )}
                {GRADE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {gradeLevelLabel(level)}
                  </option>
                ))}
              </select>
              {solo && (
                <p id="grade-hint" className={hint}>
                  Questions are written for this level.
                </p>
              )}
              <ErrorMessage id="grade-error">
                {errors.gradeLevel}
              </ErrorMessage>
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
                className={`${field} text-lg`}
              >
                {QUESTION_COUNTS.map((n) => (
                  <option key={n} value={String(n)}>
                    {n}
                  </option>
                ))}
              </select>
              <ErrorMessage id="count-error">
                {errors.questionCount}
              </ErrorMessage>
            </div>
          </div>

          {!solo && (
            <fieldset key={`mode-${values.questionMode}`} className="flex flex-col gap-2">
              <legend className={`${label} mb-2`}>Question mode</legend>
              <div className={`${cards} sm:grid-cols-2`}>
                {QUESTION_MODES.map((m) => (
                  <label key={m} className={`${optionCard} items-start`}>
                    <input
                      type="radio"
                      id={`mode-${m}`}
                      name="questionMode"
                      value={m}
                      defaultChecked={values.questionMode === m}
                      aria-describedby={describedBy(
                        `mode-${m}-hint`,
                        errors.questionMode && "mode-error",
                      )}
                      className={`${optionRadio} mt-1`}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-lg font-semibold">{questionModeLabel(m)}</span>
                      <span id={`mode-${m}-hint`} className="text-lg text-ink-700">
                        {questionModeHint(m)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <ErrorMessage id="mode-error">
                {errors.questionMode}
              </ErrorMessage>
            </fieldset>
          )}
        </div>
      )}

      <ErrorMessage alert>
        {errors.form}
      </ErrorMessage>

      <div className="flex flex-col-reverse gap-3 border-t border-ink-200 pt-6 sm:flex-row sm:items-center sm:justify-end">
        <Link href={cancelHref} className={secondaryButton}>
          Cancel
        </Link>
        {teacherCreate ? (
          <>
            <button
              type="submit"
              name="then"
              value="save"
              disabled={pending}
              className={`${quietButton} ${sharedOnly}`}
            >
              {pending && then === "save" ? pendingLabel : "Save draft"}
            </button>
            <button
              type="submit"
              name="then"
              value="save"
              disabled={pending}
              className={perStudentPrimary}
            >
              {pending && then === "save" ? pendingLabel : "Save draft"}
            </button>
            <button
              type="submit"
              name="then"
              value="generate"
              disabled={pending}
              className={`${primaryButton} ${sharedOnly}`}
            >
              {pending && then === "generate" ? pendingLabel : "Create & generate"}
            </button>
          </>
        ) : (
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? (solo && textMode ? "Starting…" : pendingLabel) : solo ? "Start reading" : "Save changes"}
          </button>
        )}
      </div>
    </form>
  );
}
