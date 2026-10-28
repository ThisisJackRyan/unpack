import type { Metadata } from "next";
import Link from "next/link";
import { questionRole } from "@/lib/ai/prompts";
import { effectiveGradeLevel, gradeLevelLabel } from "@/lib/grade-levels";
import { questionCountLabel, questionModeLabel } from "@/lib/question-modes";
import { capDetail, capHeadline, capView, type CapView } from "@/lib/reading-cap";
import { getReadingCap } from "@/lib/readings";
import { listSharedQuestions } from "@/lib/shared-questions-db";
import type { StudentSet } from "@/lib/student-sets";
import { listStudentSets } from "@/lib/student-sets-db";
import { sourceHost } from "@/lib/validate-reading";
import { ReadingStatusBadge } from "@/components/reading-status-badge";
import { MetaLine } from "@/components/meta-line";
import { StudentReadingStatusBadge } from "@/components/student-reading-status-badge";
import { TeacherAnswerList } from "@/components/teacher-answers";
import { TrimmedNote } from "@/components/trimmed-note";
import { backLink, card, focusRing, secondaryButton, textLink } from "@/components/ui";
import { cellKey, NOT_STARTED_CELL, passedSummary, triesLabel, type ClassStatus } from "@/lib/class-status";
import { loadClassStatus } from "@/lib/class-status-db";
import { answersFor, type TeacherAnswers } from "@/lib/teacher-answers";
import { loadTeacherAnswers } from "@/lib/teacher-answers-db";
import { getOrCreateTeacher } from "@/lib/teacher";
import { loadReading } from "../../loaders";
import { RaiseCapButton } from "./cap-raise";
import { DeleteReadingButton } from "./delete-reading";
import { deleteReadingAction, raiseCapAction } from "./reading-actions";
import { questionAction } from "./question-actions";
import { GENERATE_FLAG, shouldAutoGenerate } from "./question-state";
import { QuestionNumber, QuestionsPanel, QuestionText } from "./questions-panel";

// Server actions on this page call the model, which
// QUESTION_WRITE_DEADLINE_MS (110s, in src/lib/ai/settings.ts) ends at the
// latest, attempts and retries included. 150 leaves room for the lookups
// and the commit.
export const maxDuration = 150;

type Props = {
  params: Promise<{ id: string; readingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id, readingId } = await params;
  const { reading } = await loadReading(id, readingId);
  return { title: reading.title };
}

export default async function ReadingPage({ params, searchParams }: Props) {
  const { id, readingId } = await params;
  const { [GENERATE_FLAG]: generateFlag } = await searchParams;
  const { reading, class: found } = await loadReading(id, readingId);
  const classHref = `/teacher/classes/${found.id}`;
  const host = sourceHost(reading.sourceUrl);
  const paragraphs = reading.bodyText.split(/\n{2,}/);
  const shared = reading.questionMode === "shared";
  const questions = shared ? await listSharedQuestions(reading.id) : [];
  // Sets exist only once students open a published per-student reading.
  const perStudentPublished = !shared && reading.status === "published";
  const teacher = await getOrCreateTeacher();
  const [studentSets, cap] = perStudentPublished
    ? await Promise.all([listStudentSets(reading.id, found.id), getReadingCap(found.id, teacher.id, reading.id)])
    : [null, undefined];
  const capPanel = cap ? capView(cap) : ({ kind: "none" } as const);
  // Each student's answers once published. Owner-scoped in the SQL (this
  // class and the signed-in teacher); the reading id only narrows it.
  const [classStatus, answers] =
    reading.status === "published"
      ? await Promise.all([
          loadClassStatus(found.id, teacher.id),
          loadTeacherAnswers(found.id, teacher.id, { readingId: reading.id }),
        ])
      : [null, null];
  const gradeLabel = gradeLevelLabel(effectiveGradeLevel(reading.gradeLevel, found.gradeLevel));

  return (
    <div className="flex flex-col gap-8">
      <Link href={classHref} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span>{" "}
        <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <ReadingStatusBadge status={reading.status} />
          <h1 className="text-3xl font-semibold tracking-tight break-words text-ink-950">
            {reading.title}
          </h1>
        </div>
        <Link href={`${classHref}/readings/${reading.id}/edit`} className={secondaryButton}>
          {reading.status === "draft" ? "Edit" : "Edit title"}
        </Link>
      </div>

      <dl className={`${card} grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2 sm:p-6`}>
        <Detail term="Grade level">
          {reading.gradeLevel
            ? gradeLevelLabel(reading.gradeLevel)
            : `Class grade (${gradeLevelLabel(found.gradeLevel)})`}
        </Detail>
        <Detail term="Questions">{reading.questionCount}</Detail>
        <Detail term="Question mode">{questionModeLabel(reading.questionMode)}</Detail>
        <Detail term="Source">
          {host && reading.sourceUrl ? (
            <a
              href={reading.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded font-medium break-all text-primary-700 underline underline-offset-2 hover:text-primary-900 ${focusRing}`}
            >
              {host}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            "Pasted text"
          )}
        </Detail>
      </dl>

      <section aria-labelledby="questions-heading" className={`${card} p-5 sm:p-6`}>
        {reading.status === "draft" ? (
          <QuestionsPanel
            action={questionAction.bind(null, found.id, reading.id)}
            mode={reading.questionMode}
            questionCount={reading.questionCount}
            gradeLabel={gradeLabel}
            questions={questions}
            autoGenerate={shouldAutoGenerate({
              flag: generateFlag,
              status: reading.status,
              mode: reading.questionMode,
              questionCount: questions.length,
            })}
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2 id="questions-heading" className="text-xl font-semibold text-ink-950">
                  Questions
                </h2>
                <MetaLine
                  className="text-lg text-ink-700"
                  parts={[questionCountLabel(reading.questionCount), `Written for ${gradeLabel}`]}
                />
              </div>
              {shared && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink-100 px-3 py-1 text-base font-semibold text-ink-700">
                  <LockIcon />
                  Locked
                </span>
              )}
            </div>
            {shared ? (
              <>
                <ol className="flex flex-col gap-3" aria-label="Questions">
                  {questions.map((q) => (
                    <li key={q.id} className="flex gap-4 rounded-2xl border border-ink-200 bg-white p-4">
                      <QuestionNumber n={q.position} />
                      <QuestionText role={questionRole(q.position, reading.questionCount)} prompt={q.prompt} />
                    </li>
                  ))}
                </ol>
                <p className="text-lg text-ink-700">
                  Questions are locked once a reading is published.
                </p>
              </>
            ) : (
              <p className="text-lg text-ink-700">
                Each student gets their own set when they first open this reading.
              </p>
            )}
          </div>
        )}
      </section>

      {capPanel.kind !== "none" && (
        <CapPanel view={capPanel} raiseAction={raiseCapAction.bind(null, found.id, reading.id)} />
      )}

      {studentSets && <StudentSets sets={studentSets} />}

      {classStatus && answers && (
        <StudentAnswers classId={found.id} readingId={reading.id} status={classStatus} answers={answers} />
      )}

      <section aria-labelledby="text-heading" className={`${card} px-6 py-8 sm:px-10 sm:py-10`}>
        <h2 id="text-heading" className="sr-only">
          Reading text
        </h2>
        <div className="mx-auto flex max-w-prose flex-col gap-5 text-lg leading-relaxed text-ink-800">
          {reading.bodyTrimmed && <TrimmedNote />}
          {paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line break-words">
              {p}
            </p>
          ))}
        </div>
      </section>

      <section aria-labelledby="delete-reading-heading" className={`${card} flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6`}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id="delete-reading-heading" className="text-lg font-semibold text-ink-950">
            Delete this reading
          </h2>
          <p className="text-lg text-ink-700">Removes it for everyone, with every student’s answers and tries.</p>
        </div>
        <DeleteReadingButton action={deleteReadingAction.bind(null, found.id, reading.id)} title={reading.title} />
      </section>
    </div>
  );
}

// The student set cap: a calm note near or at it, with the one-time
// raise, and the new limit after (full again at the new limit: no
// button, it can't go higher). Amber while the raise is still there to
// use, and again when a raised reading is almost full (285 to 299 of
// 300); indigo otherwise after the raise. Not red: nothing is lost. The
// headline is a live region, so the change after a raise is announced.
function CapPanel({
  view,
  raiseAction,
}: {
  view: Exclude<CapView, { kind: "none" }>;
  raiseAction: () => Promise<{ message?: string; error?: string }>;
}) {
  // raised_near stays amber: almost full again is a heads-up, like near.
  const raised = view.kind === "raised" || view.kind === "raised_full";
  return (
    <section
      aria-labelledby="cap-heading"
      className={`flex flex-col gap-4 rounded-2xl border p-5 sm:p-6 ${
        raised ? "border-primary-200 bg-primary-50/60" : "border-warning-200 bg-warning-50"
      }`}
    >
      <div className="flex flex-col gap-1">
        <h2 id="cap-heading" aria-live="polite" className="text-lg font-semibold text-ink-950">
          {capHeadline(view)}
        </h2>
        <p className="text-lg text-ink-700">{capDetail(view)}</p>
      </div>
      {(view.kind === "near" || view.kind === "full") && <RaiseCapButton action={raiseAction} raiseTo={view.raiseTo} />}
    </section>
  );
}

// Each student's own set, collapsed so a class of 30 stays scannable.
// Native <details>, so it works and is keyboard accessible without JS.
function StudentSets({ sets }: { sets: StudentSet[] }) {
  return (
    <section aria-labelledby="student-sets-heading" className={`${card} flex flex-col gap-4 p-5 sm:p-6`}>
      <div className="flex flex-col gap-1">
        <h2 id="student-sets-heading" className="text-xl font-semibold text-ink-950">
          Student questions
        </h2>
        <p className="text-lg text-ink-700">
          {sets.length === 1 ? "1 student has a set." : `${sets.length} students have a set.`}
        </p>
      </div>
      {sets.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ink-300 bg-ink-50 px-6 py-8 text-center text-lg text-ink-700">
          No student has opened this reading yet. Each student’s questions show up here after they open it.
        </p>
      ) : (
        <ul className="divide-y divide-ink-200 overflow-hidden rounded-2xl border border-ink-200">
          {sets.map((set) => (
            <li key={set.studentId}>
              <details className="group">
                <summary
                  className={`flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 hover:bg-ink-50 focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden ${focusRing}`}
                >
                  <span className="min-w-0 text-lg font-semibold break-words text-ink-950">{set.name}</span>
                  <span className="flex shrink-0 items-center gap-3 text-lg text-ink-700">
                    {questionCountLabel(set.questions.length)}
                    <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                      ›
                    </span>
                  </span>
                </summary>
                <ol className="flex flex-col gap-3 bg-ink-50 px-4 py-4" aria-label={`${set.name}’s questions`}>
                  {set.questions.map((q) => (
                    <li key={q.id} className="flex gap-4 rounded-2xl border border-ink-200 bg-white p-4">
                      <QuestionNumber n={q.position} />
                      <QuestionText role={questionRole(q.position, set.questions.length)} prompt={q.prompt} />
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Each student's answers on this reading, one collapsed row per student
// (name, status, tries), opening to every question's answer on each try,
// Passed or Not yet, and the latest tip. Native <details>, like the sets.
function StudentAnswers({
  classId,
  readingId,
  status,
  answers,
}: {
  classId: string;
  readingId: string;
  status: ClassStatus;
  answers: TeacherAnswers;
}) {
  return (
    <section aria-labelledby="student-answers-heading" className={`${card} flex flex-col gap-4 p-5 sm:p-6`}>
      <div className="flex flex-col gap-1">
        <h2 id="student-answers-heading" className="text-xl font-semibold text-ink-950">
          Student answers
        </h2>
        <p className="text-lg text-ink-700">{passedSummary(status, readingId)}</p>
      </div>
      {status.students.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-ink-300 bg-ink-50 px-6 py-8 text-center text-lg text-ink-700">
          No students yet. Their answers show up here after they check them.
        </p>
      ) : (
        <ul className="divide-y divide-ink-200 overflow-hidden rounded-2xl border border-ink-200">
          {status.students.map((student) => {
            const cell = status.cells[cellKey(student.id, readingId)] ?? NOT_STARTED_CELL;
            const summary = (
              <>
                <span className="min-w-0 text-lg font-semibold break-words text-ink-950">{student.name}</span>
                <span className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                  {cell.status !== "not_started" && (
                    <span className="text-lg text-ink-700 tabular-nums">{triesLabel(cell)}</span>
                  )}
                  <StudentReadingStatusBadge audience="teacher" status={cell.status} size="sm" />
                </span>
              </>
            );
            return (
              <li key={student.id}>
                {cell.tries === 0 ? (
                  <div className="flex min-h-14 flex-wrap items-center justify-between gap-4 px-4 py-3">{summary}</div>
                ) : (
                  <details className="group">
                    <summary
                      className={`flex min-h-14 cursor-pointer list-none flex-wrap items-center justify-between gap-4 px-4 py-3 hover:bg-ink-50 focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden ${focusRing}`}
                    >
                      {summary}
                      <span aria-hidden="true" className="transition-transform group-open:rotate-90">
                        ›
                      </span>
                    </summary>
                    <div className="flex flex-col gap-3 bg-ink-50 px-4 py-4">
                      <TeacherAnswerList questions={answersFor(answers, student.id, readingId)} headingLevel={3} />
                      <Link href={`/teacher/classes/${classId}/students/${student.id}`} className={`${textLink} self-start text-lg`}>
                        All of {student.name}’s readings
                      </Link>
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-lg font-medium text-ink-700">{term}</dt>
      <dd className="text-lg font-semibold text-ink-950">{children}</dd>
    </div>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor">
      <path d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z" />
    </svg>
  );
}
