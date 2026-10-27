import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoCopyText } from "@/components/no-copy";
import { backLink, card } from "@/components/ui";
import { questionCountLabel } from "@/lib/question-modes";
import { answerStage, stageAnnouncement, type AnswerStage } from "@/lib/reading-progress";
import { loadReadingProgress } from "@/lib/reading-progress-db";
import { getStudentSession, requireStudentSession } from "@/lib/student-auth";
import type { StudentQuestion } from "@/lib/student-questions-core";
import { PENDING_MAX_REFRESHES, readingParagraphs, sourceHost } from "@/lib/student-reading-view";
import { getPublishedReading, loadStudentReading } from "@/lib/student-readings";
import { MAX_TRIES } from "@/lib/validate-answers";
import { sendChallengeAction, submitAnswersAction } from "./actions";
import { AnswerForm } from "@/components/answer-form";
import { AnswerReview } from "@/components/answer-parts";
import { Banner } from "@/components/banner";
import { ChallengeForm } from "./challenge-form";
import { PendingRefresh, RetryButton } from "@/components/refresh";
import { QuestionSkeletons } from "@/components/question-skeletons";

// A student's first open of a unique per student reading writes their set,
// which QUESTION_WRITE_DEADLINE_MS (110s, in src/lib/ai/settings.ts) ends
// at the latest, attempts and retries included. 150 leaves room for the
// lookups and the commit, the same budget as the teacher reading page. The
// answer check runs in this page's server action, and its deadline
// (EFFORT_CHECK_DEADLINE_MS, 60s) fits well inside it too.
export const maxDuration = 150;

type Props = { params: Promise<{ readingId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { readingId } = await params;
  const session = await getStudentSession();
  const reading = session && (await getPublishedReading(session.class.id, readingId));
  return { title: reading ? reading.title : "Reading" };
}

// The read view (copy and paste blocked, see src/lib/anti-copy.ts), then
// the questions: answer boxes and one check for all of them, up to 3 tries
// (and EFFORT_CHECK_LIMIT checks), then a note to the teacher. A passed
// reading shows its passing answers.
export default async function StudentReadingPage({ params }: Props) {
  const { readingId } = await params;
  const session = await requireStudentSession();
  const { reading, view } = await loadStudentReading(session, readingId);
  if (!reading) notFound();

  const host = sourceHost(reading.sourceUrl);
  const stage =
    view.kind === "questions" ? answerStage(await loadReadingProgress(session.student.id, reading.id)) : null;

  return (
    <div className="flex flex-col gap-8">
      <Link href="/c" className={`${backLink} self-start text-lg`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {session.class.name}</span>
      </Link>

      <div className="flex flex-col gap-2">
        <p className="text-lg text-zinc-600">
          {questionCountLabel(reading.questionCount)}
          {host && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>From <span className="break-all">{host}</span>
            </>
          )}
        </p>
        <h1 id="reading-title" className="text-4xl font-semibold tracking-tight break-words text-zinc-950">
          {reading.title}
        </h1>
      </div>

      <article aria-labelledby="reading-title" className={`${card} rounded-2xl px-6 py-8 sm:px-10 sm:py-10`}>
        <NoCopyText className="flex max-w-[65ch] flex-col gap-6 text-[1.1875rem] leading-[1.8] text-zinc-800 sm:text-xl sm:leading-[1.8]">
          {readingParagraphs(reading.bodyText).map((p, i) => (
            <p key={i} className="break-words whitespace-pre-line">
              {p}
            </p>
          ))}
        </NoCopyText>
      </article>

      {/* Stays mounted while the stage changes, so a screen reader hears the
          result of a check or a sent note. */}
      <p aria-live="polite" className="sr-only">
        {stage ? stageAnnouncement(stage) : ""}
      </p>

      <section aria-labelledby="questions-heading" className="flex flex-col gap-5">
        <h2 id="questions-heading" className="text-2xl font-semibold tracking-tight text-zinc-950">
          Your questions
        </h2>

        {view.kind === "questions" && stage && (
          <QuestionsStage readingId={reading.id} questions={view.questions} stage={stage} />
        )}

        {view.kind === "pending" && (
          <PendingRefresh retryAfterMs={view.retryAfterMs} maxTries={PENDING_MAX_REFRESHES}>
            <QuestionSkeletons count={reading.questionCount} />
          </PendingRefresh>
        )}

        {view.kind === "limit_reached" && (
          <p className={`${card} rounded-2xl px-6 py-10 text-center text-lg text-zinc-700`}>{view.message}</p>
        )}

        {view.kind === "calls_used_up" && (
          <div className={`${card} flex flex-col items-start gap-5 rounded-2xl p-6`}>
            <p aria-live="polite" className="text-lg text-zinc-700">
              {view.message}
            </p>
            <RetryButton />
          </div>
        )}

        {view.kind === "throttled" && (
          <div className={`${card} flex flex-col items-start gap-5 rounded-2xl p-6`}>
            <p aria-live="polite" className="text-lg text-zinc-700">
              {view.message}
            </p>
            <RetryButton />
          </div>
        )}

        {view.kind === "error" && (
          <div className={`${card} flex flex-col items-start gap-5 rounded-2xl p-6`}>
            <p aria-live="polite" className="text-lg text-zinc-700">
              {view.message}
            </p>
            <RetryButton />
          </div>
        )}
      </section>
    </div>
  );
}

function QuestionsStage({
  readingId,
  questions,
  stage,
}: {
  readingId: string;
  questions: StudentQuestion[];
  stage: AnswerStage;
}) {
  switch (stage.kind) {
    case "answer":
      return (
        <AnswerForm
          action={submitAnswersAction.bind(null, readingId)}
          questions={questions}
          tryNumber={stage.tryNumber}
          maxTries={stage.maxTries}
          previous={stage.previous}
          extraTry={stage.extraTry}
        />
      );
    case "passed":
      return (
        <>
          <Banner tone="done" title={stage.byTeacher ? "Your teacher accepted your answers." : "You passed! Nice work."}>
            {stage.byTeacher ? "This reading is done. Nice work sticking with it!" : "This reading is done. Here are your answers."}
          </Banner>
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults={false} />}
        </>
      );
    case "out_of_tries":
      return (
        <>
          <Banner tone="info" title={stage.extraTry ? "That was your extra try." : `You used all ${MAX_TRIES} tries.`}>
            Here is what you wrote last time, with tips.
          </Banner>
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults />}
          <ChallengeForm
            action={sendChallengeAction.bind(null, readingId)}
            intro={
              stage.extraTry
                ? "If you think you did your best, you can send your teacher a new note. They will read your answers and your note."
                : `You tried ${MAX_TRIES} times. If you think you did your best, tell your teacher why. They will read your answers and your note.`
            }
          />
        </>
      );
    case "check_limit":
      // Every check is used (some failed on our side), so answering stops
      // here, tries left or not; the note is the way forward.
      return (
        <>
          <Banner tone="info" title="We couldn’t check your answers.">
            {stage.attempt
              ? "Send a note to your teacher. They will read your answers and your note."
              : "Send a note to your teacher. They will read your note."}
          </Banner>
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults />}
          <ChallengeForm action={sendChallengeAction.bind(null, readingId)} />
        </>
      );
    case "challenged":
      return (
        <>
          {stage.status === "open" ? (
            <Banner tone="info" title="Sent! Your teacher will take a look.">
              {/* No saved try when every check failed (the check limit). */}
              {stage.attempt ? "You can read your answers below while you wait." : "Check back here later."}
            </Banner>
          ) : (
            <Banner tone="info" title="Your teacher read your note.">
              Thanks for telling them how it went. Ask your teacher if you want to talk about this one.
            </Banner>
          )}
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults />}
        </>
      );
  }
}
