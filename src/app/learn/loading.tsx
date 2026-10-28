import { card } from "@/components/ui";

export default function LearnLoading() {
  return (
    <div aria-busy="true" className="flex animate-pulse flex-col gap-8 motion-reduce:animate-none">
      <span className="sr-only">Loading</span>
      <div className="flex items-center justify-between">
        <div className="h-9 w-48 rounded-2xl bg-ink-200" />
        <div className="h-14 w-40 rounded-2xl bg-ink-200" />
      </div>
      <div className={`${card} divide-y divide-ink-200`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between px-5 py-5">
            <div className="flex flex-col gap-2">
              <div className="h-5 w-40 rounded-full bg-ink-200" />
              <div className="h-4 w-24 rounded-full bg-ink-100" />
            </div>
            <div className="h-8 w-24 rounded-full bg-ink-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
