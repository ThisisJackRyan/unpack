import { QuestionSkeletons } from "./skeleton";

// Shown while the page loads, which on a student's first open of a unique
// per student reading includes writing their questions.
export default function StudentReadingLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-8">
      <div className="flex animate-pulse flex-col gap-3">
        <div className="h-5 w-32 rounded bg-zinc-200" />
        <div className="h-10 w-3/4 rounded-lg bg-zinc-200" />
      </div>
      <p aria-live="polite" className="text-lg font-medium text-zinc-700">
        Getting your questions ready…
      </p>
      <QuestionSkeletons count={3} />
    </div>
  );
}
