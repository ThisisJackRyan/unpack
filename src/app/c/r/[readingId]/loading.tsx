import { WritingQuestions } from "@/components/writing-questions";
import { GETTING_QUESTIONS_READY } from "@/components/writing-questions-text";

// Shown while the page loads, which on a student's first open of a unique
// per student reading includes writing their questions.
export default function StudentReadingLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <div className="flex animate-pulse flex-col gap-3 motion-reduce:animate-none">
        <div className="h-5 w-32 rounded-full bg-ink-200" />
        <div className="h-10 w-3/4 rounded-2xl bg-ink-200" />
      </div>
      <WritingQuestions label={GETTING_QUESTIONS_READY} />
    </div>
  );
}
