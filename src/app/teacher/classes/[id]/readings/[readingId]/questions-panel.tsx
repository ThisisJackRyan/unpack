"use client";

import { unstable_rethrow } from "next/navigation";
import {
  useActionState,
  useEffect,
  startTransition,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { questionRole, type QuestionRole } from "@/lib/ai/prompts";
import { withRejectionFallback } from "@/components/action-fallback";
import { questionPanelFallback } from "./question-state";
import { questionCountLabel } from "@/lib/question-modes";
import { LAST_QUESTION_MESSAGE } from "@/lib/shared-questions";
import { ErrorMessage } from "@/components/error-message";
import { LimitNotice } from "@/components/limit-notice";
import { MetaLine } from "@/components/meta-line";
import {
  actionButton,
  dangerActionButton,
  dangerButton,
  focusRing,
  primaryButton,
  secondaryButton,
} from "@/components/ui";
import { RetryIcon } from "@/components/answer-parts";
import { WritingQuestions } from "@/components/writing-questions";
import { WRITING_A_SAMPLE, WRITING_ONE_QUESTION, WRITING_QUESTIONS_TEACHER } from "@/components/writing-questions-text";
import {
  QUESTION_MAX_LENGTH,
  type QuestionActionState,
  type QuestionIntent,
} from "./question-state";

type Question = { id: string; position: number; prompt: string };

type Props = {
  action: (
    state: QuestionActionState,
    formData: FormData,
  ) => Promise<QuestionActionState>;
  mode: "shared" | "per_student";
  questionCount: number;
  gradeLabel: string;
  questions: Question[];
  // Arrived from "Create & generate": write the set once on load.
  autoGenerate?: boolean;
};

type Running = { intent: QuestionIntent; questionId?: string };


const ROLE_LABELS: Record<QuestionRole, string> = {
  detail: "From the text",
  own_take: "Your take",
  detail_and_own_take: "From the text + your take",
};

// Numbered, stacked question cards with inline edit and per-card actions
// (modeled on the Google Gemini "Creating a quiz" flow), a friendly "Writing
// questions…" card while writing, and a confirm step before Regenerate all, Publish, and
// Delete.
export function QuestionsPanel({ action, mode, questionCount, gradeLabel, questions, autoGenerate = false }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  // Where focus goes once an action finishes (the card's Edit button after
  // a save, the list after a delete).
  const focusAfter = useRef<string | null>(null);

  // A request that fails outright (no answer, a 504, a lapsed session, a
  // deploy) is an error on the panel or its card, never the page's error
  // boundary (see questionPanelFallback).
  const guarded = withRejectionFallback(action, questionPanelFallback, unstable_rethrow);
  const [state, dispatch, pending] = useActionState(
    async (prev: QuestionActionState, formData: FormData) => {
      const next = await guarded(prev, formData);
      if (next.ok && next.intent === "update") {
        setEditingId(null);
        focusAfter.current = `edit-${next.questionId}`;
      }
      if (next.ok && next.intent === "delete") focusAfter.current = "questions-heading";
      return next;
    },
    {},
  );

  // "Create & generate": run the Generate button's intent once, then drop
  // the flag from the address so a reload doesn't ask again.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoGenerate || autoStarted.current) return;
    autoStarted.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    const data = new FormData();
    data.set("intent", "generate");
    setRunning({ intent: "generate" });
    startTransition(() => dispatch(data));
  }, [autoGenerate, dispatch]);

  useEffect(() => {
    if (pending || !focusAfter.current) return;
    document.getElementById(focusAfter.current)?.focus();
    focusAfter.current = null;
  }, [pending, state]);

  // Records which control started the action, so only it shows a pending
  // label. Runs as an event handler, before the action's transition.
  function track(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    setRunning({
      intent: data.get("intent") as QuestionIntent,
      questionId: String(data.get("questionId") ?? "") || undefined,
    });
  }

  const busy = (intent: QuestionIntent, questionId?: string) =>
    pending &&
    running?.intent === intent &&
    (questionId === undefined || running.questionId === questionId);
  const writingSet = busy("generate") || busy("regenerate_all") || busy("sample");
  const cardError = (id: string) =>
    !state.ok && state.questionId === id ? state.error : undefined;
  const panelError = !state.ok && !state.questionId ? state.error : undefined;

  const shared = mode === "shared";
  const hasSet = questions.length > 0;
  const canPublish = !shared || questions.length === questionCount;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2
            id="questions-heading"
            tabIndex={-1}
            className="rounded text-xl font-semibold text-ink-950 focus:outline-none"
          >
            Questions
          </h2>
          <MetaLine
            className="text-lg text-ink-700"
            parts={[questionCountLabel(questionCount), `Written for ${gradeLabel}`]}
          />
        </div>
        {shared && hasSet && (
          <ConfirmButton
            label="Regenerate all"
            pendingLabel={WRITING_QUESTIONS_TEACHER}
            isPending={busy("regenerate_all")}
            disabled={pending}
            title="Write a new set?"
            body="This replaces every question, including your edits."
            confirmLabel="Write a new set"
            intent="regenerate_all"
            dispatch={dispatch}
            track={track}
            className={secondaryButton}
          />
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {pending
          ? writingSet || busy("regenerate_one")
            ? WRITING_QUESTIONS_TEACHER
            : "Saving…"
          : state.ok
            ? state.status
            : ""}
      </p>
      <ErrorMessage alert>
        {panelError}
      </ErrorMessage>
      {!pending && state.limit && <LimitNotice>{state.limit}</LimitNotice>}

      {shared ? (
        busy("generate") || busy("regenerate_all") ? (
          <WritingQuestions label={WRITING_QUESTIONS_TEACHER} announce={false} />
        ) : hasSet ? (
          <ol className="flex flex-col gap-3" aria-label="Questions">
            {questions.map((q) => (
              <QuestionCard
                key={`${q.id}-${q.prompt}`}
                question={q}
                role={questionRole(q.position, questionCount)}
                editing={editingId === q.id}
                onEdit={() => setEditingId(q.id)}
                onCancel={() => {
                  setEditingId(null);
                  focusAfter.current = `edit-${q.id}`;
                  // No action runs, so focus right away.
                  requestAnimationFrame(() => document.getElementById(`edit-${q.id}`)?.focus());
                }}
                regenerating={busy("regenerate_one", q.id)}
                saving={busy("update", q.id)}
                deleting={busy("delete", q.id)}
                disabled={pending}
                canDelete={questions.length > 1}
                error={cardError(q.id)}
                dispatch={dispatch}
                track={track}
              />
            ))}
          </ol>
        ) : (
          <EmptyState
            title="No questions yet"
            body={`We’ll write ${questionCountLabel(questionCount)} from this reading. You can edit them before you publish.`}
          >
            <IntentForm intent="generate" dispatch={dispatch} track={track}>
              <button type="submit" disabled={pending} className={primaryButton}>
                {busy("generate") ? WRITING_QUESTIONS_TEACHER : "Generate questions"}
              </button>
            </IntentForm>
          </EmptyState>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-lg text-ink-700">
            Each student gets their own {questionCountLabel(questionCount)} when they first
            open this reading. Their set is saved, so it stays the same if they try again.
          </p>
          <IntentForm intent="sample" dispatch={dispatch} track={track}>
            <button type="submit" disabled={pending} className={secondaryButton}>
              {busy("sample") ? "Writing a sample…" : "Preview a sample"}
            </button>
          </IntentForm>
          {busy("sample") ? (
            <WritingQuestions label={WRITING_A_SAMPLE} announce={false} />
          ) : (
            state.sample && (
              <div className="flex flex-col gap-3">
                <p className="text-lg font-semibold text-ink-900">
                  Sample only. It isn’t saved, and each student gets their own set.
                </p>
                <ol className="flex flex-col gap-3" aria-label="Sample questions">
                  {state.sample.map((prompt, i) => (
                    <li
                      key={i}
                      className="flex gap-4 rounded-2xl border border-dashed border-ink-300 bg-ink-50 p-4"
                    >
                      <QuestionNumber n={i + 1} />
                      <QuestionText
                        role={questionRole(i + 1, state.sample!.length)}
                        prompt={prompt}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            )
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-ink-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p id="publish-hint" className="text-lg text-ink-700">
          {canPublish
            ? "Publishing shows it to the class and locks the questions."
            : "Write the questions before you publish."}
        </p>
        <ConfirmButton
          label="Publish"
          pendingLabel="Publishing…"
          isPending={busy("publish")}
          disabled={pending || !canPublish}
          describedBy="publish-hint"
          title="Publish this reading?"
          body="Students in this class will see it. You can’t edit the reading or its questions after."
          confirmLabel="Publish"
          intent="publish"
          dispatch={dispatch}
          track={track}
          className={primaryButton}
        />
      </div>
    </div>
  );
}

type Dispatch = (formData: FormData) => void;

function IntentForm({
  intent,
  questionId,
  dispatch,
  track,
  children,
  className,
  onSubmit,
}: {
  intent: QuestionIntent;
  questionId?: string;
  dispatch: Dispatch;
  track: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  className?: string;
  onSubmit?: () => void;
}) {
  return (
    <form
      action={dispatch}
      onSubmit={(e) => {
        track(e);
        onSubmit?.();
      }}
      className={className}
    >
      <input type="hidden" name="intent" value={intent} />
      {questionId && <input type="hidden" name="questionId" value={questionId} />}
      {children}
    </form>
  );
}

// A button that opens a native modal dialog (focus trapped, Escape closes,
// focus returns to the button) to confirm before the action runs.
function ConfirmButton({
  label,
  pendingLabel,
  isPending,
  disabled,
  describedBy,
  buttonTitle,
  title,
  body,
  confirmLabel,
  confirmClassName = primaryButton,
  intent,
  questionId,
  dispatch,
  track,
  className,
}: {
  label: ReactNode;
  pendingLabel: string;
  isPending: boolean;
  disabled: boolean;
  describedBy?: string;
  buttonTitle?: string;
  title: string;
  body: string;
  confirmLabel: string;
  confirmClassName?: string;
  intent: QuestionIntent;
  questionId?: string;
  dispatch: Dispatch;
  track: (event: FormEvent<HTMLFormElement>) => void;
  className: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = questionId ? `confirm-${intent}-${questionId}` : `confirm-${intent}`;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={describedBy}
        title={buttonTitle}
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
        className={className}
      >
        {isPending ? pendingLabel : label}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-3xl bg-white p-6 shadow-xl backdrop:bg-ink-950/40"
      >
        <h2 id={`${id}-title`} className="text-xl font-semibold text-ink-950">
          {title}
        </h2>
        <p id={`${id}-body`} className="mt-2 text-lg text-ink-700">
          {body}
        </p>
        <IntentForm
          intent={intent}
          questionId={questionId}
          dispatch={dispatch}
          track={track}
          onSubmit={() => dialogRef.current?.close()}
          className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"
        >
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className={secondaryButton}
          >
            Cancel
          </button>
          <button type="submit" className={confirmClassName}>
            {confirmLabel}
          </button>
        </IntentForm>
      </dialog>
    </>
  );
}

function QuestionCard({
  question,
  role,
  editing,
  onEdit,
  onCancel,
  regenerating,
  saving,
  deleting,
  disabled,
  canDelete,
  error,
  dispatch,
  track,
}: {
  question: Question;
  role: QuestionRole;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  regenerating: boolean;
  saving: boolean;
  deleting: boolean;
  disabled: boolean;
  canDelete: boolean;
  error?: string;
  dispatch: Dispatch;
  track: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [length, setLength] = useState(question.prompt.length);
  const fieldId = `question-${question.id}`;
  const errorId = `${fieldId}-error`;

  // Moves focus into the editor when it opens.
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <li className="flex gap-4 rounded-2xl border border-ink-200 bg-white p-4 shadow-xs">
      <QuestionNumber n={question.position} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {regenerating ? (
          <WritingQuestions label={WRITING_ONE_QUESTION} announce={false} size="small" />
        ) : editing ? (
          <IntentForm
            intent="update"
            questionId={question.id}
            dispatch={dispatch}
            track={track}
            className="flex flex-col gap-2"
          >
            <label htmlFor={fieldId} className="text-lg font-semibold text-ink-950">
              {ROLE_LABELS[role]}
              <span className="sr-only">, question {question.position}</span>
            </label>
            <textarea
              ref={textareaRef}
              id={fieldId}
              name="prompt"
              rows={3}
              maxLength={QUESTION_MAX_LENGTH}
              defaultValue={question.prompt}
              onChange={(e) => setLength(e.currentTarget.value.length)}
              onKeyDown={onKeyDown}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : `${fieldId}-count`}
              className={`block w-full rounded-2xl border-2 border-ink-400 bg-white px-3 py-2 text-lg leading-relaxed text-ink-950 aria-invalid:border-danger-600 ${focusRing}`}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p id={`${fieldId}-count`} className="text-lg text-ink-700 tabular-nums">
                {length} / {QUESTION_MAX_LENGTH}
                <span className="sr-only"> characters</span>
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={onCancel} className={actionButton}>
                  Cancel
                </button>
                <button type="submit" disabled={disabled} className={primaryButton}>
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </IntentForm>
        ) : (
          <QuestionText role={role} prompt={question.prompt} />
        )}

        {error && (
          <ErrorMessage id={errorId} alert>
            {error}
          </ErrorMessage>
        )}

        {!editing && (
          <div className="flex flex-wrap gap-2">
            <button
              id={`edit-${question.id}`}
              type="button"
              disabled={disabled}
              onClick={onEdit}
              className={actionButton}
            >
              <EditIcon />
              Edit<span className="sr-only"> question {question.position}</span>
            </button>
            <IntentForm
              intent="regenerate_one"
              questionId={question.id}
              dispatch={dispatch}
              track={track}
            >
              <button type="submit" disabled={disabled} className={actionButton}>
                <RetryIcon className="h-5 w-5" />
                {regenerating ? "Writing…" : "Regenerate"}
                <span className="sr-only"> question {question.position}</span>
              </button>
            </IntentForm>
            <ConfirmButton
              label={
                <>
                  <TrashIcon />
                  Delete<span className="sr-only"> question {question.position}</span>
                </>
              }
              pendingLabel="Deleting…"
              isPending={deleting}
              disabled={disabled || !canDelete}
              buttonTitle={canDelete ? undefined : LAST_QUESTION_MESSAGE}
              title="Delete this question?"
              body="This can’t be undone."
              confirmLabel="Delete"
              confirmClassName={dangerButton}
              intent="delete"
              questionId={question.id}
              dispatch={dispatch}
              track={track}
              className={dangerActionButton}
            />
          </div>
        )}
      </div>
    </li>
  );
}

export function QuestionText({ role, prompt }: { role: QuestionRole; prompt: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-lg font-semibold text-primary-700">{ROLE_LABELS[role]}</span>
      <p className="text-lg leading-relaxed break-words text-ink-900">{prompt}</p>
    </div>
  );
}

export function QuestionNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-50 text-base font-semibold text-primary-700 tabular-nums"
    >
      {n}
    </span>
  );
}

function EmptyState({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-300 bg-ink-50 px-6 py-10 text-center">
      <h3 className="text-lg font-semibold text-ink-950">{title}</h3>
      <p className="max-w-md text-lg text-ink-700">{body}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12.5 4.5l3 3L7 16H4v-3l8.5-8.5Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 5.5h13M8 5.5V4h4v1.5M5 5.5l1 11h8l1-11M8.5 9v4.5M11.5 9v4.5" />
    </svg>
  );
}
