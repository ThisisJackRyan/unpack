// Placeholder cards while a question set is written, like the teacher
// page's skeletons.
export function QuestionSkeletons({ count }: { count: number }) {
  return (
    <ol aria-hidden="true" className="flex animate-pulse flex-col gap-3 motion-reduce:animate-none">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="flex gap-4 rounded-3xl border-2 border-ink-200 bg-white p-5">
          <div className="h-11 w-11 shrink-0 rounded-full bg-primary-100" />
          <div className="flex flex-1 flex-col gap-2 py-1.5">
            <div className="h-5 w-11/12 rounded-full bg-ink-200" />
            <div className="h-5 w-2/3 rounded-full bg-ink-200" />
          </div>
        </li>
      ))}
    </ol>
  );
}
