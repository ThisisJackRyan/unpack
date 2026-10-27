"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { questionRole, type QuestionRole } from "@/lib/ai/prompts";
import { questionCountLabel } from "@/lib/question-modes";
import { LAST_QUESTION_MESSAGE } from "@/lib/shared-questions";
import { focusRing, primaryButton, secondaryButton } from "@/components/ui";
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
};

type Running = { intent: QuestionIntent; questionId?: string };

const smallButton = `inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;
const quietButton = `${smallButton} text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950`;

const ROLE_LABELS: Record<QuestionRole, string> = {
  detail: "From the text",
  own_take: "Your take",
  detail_and_own_take: "From the text + your take",
};

// Numbered, stacked question cards with inline edit and per-card actions
// (modeled on the Google Gemini "Creating a quiz" flow), skeleton cards
// while writing, and a confirm step before Regenerate all and Publish.
export function QuestionsPanel({ action, mode, questionCount, gradeLabel, questions }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  // Where focus goes once an action finishes (the card's Edit button after
  // a save, the list after a delete).
  const focusAfter = useRef<string | null>(null);

  const [state, dispatch, pending] = useActionState(
    async (prev: QuestionActionState, formData: FormData) => {
      const next = await action(prev, formData);
      if (next.ok && next.intent === "update") {
        setEditingId(null);
        focusAfter.current = `edit-${next.questionId}`;
      }
      if (next.ok && next.intent === "delete") focusAfter.current = "questions-heading";
      return next;
    },
    {},
  );

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
            className="rounded text-xl font-semibold text-zinc-950 focus:outline-none"
          >
            Questions
          </h2>
          <p className="text-base text-zinc-600">
            {questionCountLabel(questionCount)} · Written for {gradeLabel}
          </p>
        </div>
        {shared && hasSet && (
          <ConfirmButton
            label="Regenerate all"
            pendingLabel="Writing questions…"
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
            ? "Writing questions…"
            : "Saving…"
          : state.ok
            ? state.status
            : ""}
      </p>
      <p role="alert" className="text-base text-red-700 empty:hidden">
        {panelError}
      </p>

      {shared ? (
        busy("generate") || busy("regenerate_all") ? (
          <SkeletonList count={questionCount} />
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
                {busy("generate") ? "Writing questions…" : "Generate questions"}
              </button>
            </IntentForm>
          </EmptyState>
        )
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-base text-zinc-700">
            Each student gets their own {questionCountLabel(questionCount)} when they first
            open this reading. Their set is saved, so it stays the same if they try again.
          </p>
          <IntentForm intent="sample" dispatch={dispatch} track={track}>
            <button type="submit" disabled={pending} className={secondaryButton}>
              {busy("sample") ? "Writing a sample…" : "Preview a sample"}
            </button>
          </IntentForm>
          {busy("sample") ? (
            <SkeletonList count={questionCount} />
          ) : (
            state.sample && (
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-zinc-600">
                  Sample only. It isn’t saved, and each student gets their own set.
                </p>
                <ol className="flex flex-col gap-3" aria-label="Sample questions">
                  {state.sample.map((prompt, i) => (
                    <li
                      key={i}
                      className="flex gap-4 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4"
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

      <div className="flex flex-col gap-3 border-t border-zinc-200 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p id="publish-hint" className="text-base text-zinc-600">
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
  title,
  body,
  confirmLabel,
  intent,
  dispatch,
  track,
  className,
}: {
  label: string;
  pendingLabel: string;
  isPending: boolean;
  disabled: boolean;
  describedBy?: string;
  title: string;
  body: string;
  confirmLabel: string;
  intent: QuestionIntent;
  dispatch: Dispatch;
  track: (event: FormEvent<HTMLFormElement>) => void;
  className: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = `confirm-${intent}`;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={describedBy}
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
        className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-2xl bg-white p-6 shadow-xl backdrop:bg-zinc-950/40"
      >
        <h2 id={`${id}-title`} className="text-xl font-semibold text-zinc-950">
          {title}
        </h2>
        <p id={`${id}-body`} className="mt-2 text-base text-zinc-600">
          {body}
        </p>
        <IntentForm
          intent={intent}
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
          <button type="submit" className={primaryButton}>
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
    <li className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
      <QuestionNumber n={question.position} />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {regenerating ? (
          <div aria-hidden="true" className="flex animate-pulse flex-col gap-2 py-1">
            <div className="h-3 w-24 rounded bg-zinc-100" />
            <div className="h-4 w-11/12 rounded bg-zinc-200" />
            <div className="h-4 w-2/3 rounded bg-zinc-200" />
          </div>
        ) : editing ? (
          <IntentForm
            intent="update"
            questionId={question.id}
            dispatch={dispatch}
            track={track}
            className="flex flex-col gap-2"
          >
            <label htmlFor={fieldId} className="text-sm font-medium text-zinc-500">
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
              className={`block w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-base leading-relaxed text-zinc-950 aria-invalid:border-red-600 ${focusRing}`}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p id={`${fieldId}-count`} className="text-sm text-zinc-500 tabular-nums">
                {length} / {QUESTION_MAX_LENGTH}
                <span className="sr-only"> characters</span>
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={onCancel} className={quietButton}>
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={disabled}
                  className={`${smallButton} bg-indigo-600 text-white hover:bg-indigo-700`}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </IntentForm>
        ) : (
          <QuestionText role={role} prompt={question.prompt} />
        )}

        {error && (
          <p id={errorId} role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}

        {!editing && (
          <div className="-ml-3 flex flex-wrap gap-1">
            <button
              id={`edit-${question.id}`}
              type="button"
              disabled={disabled}
              onClick={onEdit}
              className={quietButton}
            >
              Edit<span className="sr-only"> question {question.position}</span>
            </button>
            <IntentForm
              intent="regenerate_one"
              questionId={question.id}
              dispatch={dispatch}
              track={track}
            >
              <button type="submit" disabled={disabled} className={quietButton}>
                {regenerating ? "Writing…" : "Regenerate"}
                <span className="sr-only"> question {question.position}</span>
              </button>
            </IntentForm>
            <IntentForm intent="delete" questionId={question.id} dispatch={dispatch} track={track}>
              <button
                type="submit"
                disabled={disabled || !canDelete}
                title={canDelete ? undefined : LAST_QUESTION_MESSAGE}
                className={`${smallButton} text-red-700 hover:bg-red-50`}
              >
                Delete<span className="sr-only"> question {question.position}</span>
              </button>
            </IntentForm>
          </div>
        )}
      </div>
    </li>
  );
}

export function QuestionText({ role, prompt }: { role: QuestionRole; prompt: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-zinc-500">{ROLE_LABELS[role]}</span>
      <p className="text-base leading-relaxed break-words text-zinc-900">{prompt}</p>
    </div>
  );
}

export function QuestionNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-sm font-semibold text-indigo-700 tabular-nums"
    >
      {n}
    </span>
  );
}

// Placeholder cards for the set being written, one per expected question.
function SkeletonList({ count }: { count: number }) {
  return (
    <ol aria-hidden="true" className="flex animate-pulse flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-4">
          <div className="h-8 w-8 shrink-0 rounded-full bg-zinc-200" />
          <div className="flex flex-1 flex-col gap-2 py-1">
            <div className="h-3 w-24 rounded bg-zinc-100" />
            <div className="h-4 w-11/12 rounded bg-zinc-200" />
            <div className="h-4 w-2/3 rounded bg-zinc-200" />
          </div>
        </li>
      ))}
    </ol>
  );
}

function EmptyState({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-6 py-10 text-center">
      <h3 className="text-lg font-semibold text-zinc-950">{title}</h3>
      <p className="max-w-md text-base text-zinc-600">{body}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}
