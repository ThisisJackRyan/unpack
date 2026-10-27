import { WritingQuestions } from "@/components/writing-questions";
import { GETTING_QUESTIONS_READY } from "@/components/writing-questions-text";

// Shown while the page loads, which on the first open includes writing
// the reading's questions.
export default function SelfReadingLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <div className="flex animate-pulse flex-col gap-3 motion-reduce:animate-none">
        <div className="h-5 w-32 rounded bg-ink-200" />
        <div className="h-10 w-3/4 rounded-lg bg-ink-200" />
      </div>
      <WritingQuestions label={GETTING_QUESTIONS_READY} />
    </div>
  );
}
