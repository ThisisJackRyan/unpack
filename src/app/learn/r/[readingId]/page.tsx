import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnswerForm } from "@/components/answer-form";
import { AnswerReview } from "@/components/answer-parts";
import { Banner } from "@/components/banner";
import { LimitNotice } from "@/components/limit-notice";
import { NoCopyText } from "@/components/no-copy";
import { QuestionSkeletons } from "@/components/question-skeletons";
import { PendingRefresh, RetryButton } from "@/components/refresh";
import { MetaLine } from "@/components/meta-line";
import { backLink, card, primaryButtonLarge, secondaryButtonLarge } from "@/components/ui";
import { requireSelfLearner } from "@/lib/account";
import { requestRetryClock } from "@/lib/request-time-zone";
import { gradeLevelLabel } from "@/lib/grade-levels";
import { questionCountLabel } from "@/lib/question-modes";
import { soloAnnouncement, soloStage, type SoloStage } from "@/lib/self-answers-core";
import { selfQuestionsView } from "@/lib/self-questions-core";
import { getOrCreateSelfQuestions, getSelfReading, loadSelfProgress } from "@/lib/self-readings";
import type { StudentQuestion } from "@/lib/student-questions-core";
import { PENDING_MAX_REFRESHES, readingParagraphs, sourceHost } from "@/lib/student-reading-view";
import { MAX_TRIES } from "@/lib/validate-answers";
import { AllowanceLimit } from "../../allowance";
import { submitSelfAnswersAction } from "./actions";

// The first open writes the questions (QUESTION_WRITE_DEADLINE_MS, 110s,
// at the latest), and the answer check runs in this page's server action
// (EFFORT_CHECK_DEADLINE_MS, 60s): the student reading page's budget.
export const maxDuration = 150;

type Props = { params: Promise<{ readingId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { readingId } = await params;
  const account = await requireSelfLearner();
  const reading = await getSelfReading(account.id, readingId);
  return { title: reading ? reading.title : "Reading" };
}

// The self-learner's reading: the student read view (copy and paste
// blocked), their own questions, answers with the effort check and nudges,
// 3 tries. A pass is done; after the last try (or every check) they see
// the nudges and move on. No note to a teacher, no challenge. Owner only:
// another account's reading is a 404.
export default async function SelfReadingPage({ params }: Props) {
  const { readingId } = await params;
  const account = await requireSelfLearner();
  const reading = await getSelfReading(account.id, readingId);
  if (!reading) notFound();

  const result = await getOrCreateSelfQuestions(account.id, reading.id);
  const clock = await requestRetryClock();
  const view = selfQuestionsView(result, clock);
  if (view.kind === "not_found") notFound();
  const stage = view.kind === "questions" ? soloStage(await loadSelfProgress(account.id, reading.id)) : null;
  const host = sourceHost(reading.sourceUrl);

  return (
    <div className="flex flex-col gap-8">
      <Link href="/learn" className={`${backLink} self-start text-lg`}>
        <span aria-hidden="true">←</span> Back to your reading
      </Link>

      <div className="flex flex-col gap-2">
        <MetaLine
          className="text-lg text-ink-600"
          parts={[gradeLevelLabel(reading.gradeLevel), questionCountLabel(reading.questionCount), host && `From ${host}`]}
        />
        <h1 id="reading-title" className="text-4xl font-semibold tracking-tight break-words text-ink-950">
          {reading.title}
        </h1>
      </div>

      <article aria-labelledby="reading-title" className={`${card} px-6 py-8 sm:px-10 sm:py-10`}>
        <NoCopyText className="flex max-w-[65ch] flex-col gap-6 text-[1.1875rem] leading-[1.8] text-ink-800 sm:text-xl sm:leading-[1.8]">
          {readingParagraphs(reading.bodyText).map((p, i) => (
            <p key={i} className="break-words whitespace-pre-line">
              {p}
            </p>
          ))}
        </NoCopyText>
      </article>

      {/* Stays mounted while the stage changes, so a screen reader hears the
          result of a check. */}
      <p aria-live="polite" className="sr-only">
        {stage ? soloAnnouncement(stage) : ""}
      </p>

      <section aria-labelledby="questions-heading" className="flex flex-col gap-5">
        <h2 id="questions-heading" className="text-2xl font-semibold tracking-tight text-ink-950">
          Your questions
        </h2>

        {view.kind === "questions" && stage && (
          <SoloQuestions readingId={reading.id} questions={view.questions} stage={stage} />
        )}

        {view.kind === "pending" && (
          <PendingRefresh retryAfterMs={view.retryAfterMs} maxTries={PENDING_MAX_REFRESHES}>
            <QuestionSkeletons count={reading.questionCount} />
          </PendingRefresh>
        )}

        {/* This reading's questions failed before, so it gave its weekly
            slot back, and every slot is in use now. */}
        {result.status === "limit_reached" && (
          <div className="flex flex-col items-start gap-5">
            <AllowanceLimit state={result.state} now={clock.now} timeZone={clock.timeZone} utcLabel={clock.utcLabel} />
            <RetryButton />
          </div>
        )}

        {/* The question limit: a break, not an error. */}
        {view.kind === "throttled" && (
          <div className="flex flex-col items-start gap-5">
            <LimitNotice large>{view.message}</LimitNotice>
            <RetryButton />
          </div>
        )}

        {view.kind === "error" && (
          <div className={`${card} flex flex-col items-start gap-5 p-6`}>
            <p aria-live="polite" className="text-lg text-ink-700">
              {view.message}
            </p>
            <RetryButton />
          </div>
        )}

        {/* Question writing is unavailable: coming back later is the fix,
            so no Try again. */}
        {view.kind === "unavailable" && (
          <div className={`${card} flex flex-col items-start gap-5 p-6`}>
            <p role="status" className="text-lg text-ink-700">
              {view.message}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function SoloQuestions({
  readingId,
  questions,
  stage,
}: {
  readingId: string;
  questions: StudentQuestion[];
  stage: SoloStage;
}) {
  switch (stage.kind) {
    case "answer":
      return (
        <AnswerForm
          action={submitSelfAnswersAction.bind(null, readingId)}
          questions={questions}
          tryNumber={stage.tryNumber}
          maxTries={stage.maxTries}
          previous={stage.previous}
          extraTry={false}
        />
      );
    case "passed":
      return (
        <>
          <Banner tone="done" title="You passed! Nice work.">
            This reading is done. Here are your answers.
          </Banner>
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults={false} />}
          <NextSteps />
        </>
      );
    case "moved_on":
      return (
        <>
          <Banner
            tone="info"
            title={stage.reason === "tries" ? `You used all ${MAX_TRIES} tries.` : "We couldn’t check your answers this time."}
          >
            {stage.attempt
              ? "Here is what you wrote last time, with tips for next time. You can move on whenever you’re ready."
              : "You can move on whenever you’re ready."}
          </Banner>
          {stage.attempt && <AnswerReview questions={questions} answers={stage.attempt.answers} showResults />}
          <NextSteps />
        </>
      );
  }
}

function NextSteps() {
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link href="/learn/new" className={`${primaryButtonLarge}`}>
        Start a new reading
      </Link>
      <Link href="/learn/history" className={`${secondaryButtonLarge}`}>
        See your history
      </Link>
    </div>
  );
}
