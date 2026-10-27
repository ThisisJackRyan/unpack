import { card } from "@/components/ui";

export default function LearnLoading() {
  return (
    <div aria-busy="true" className="flex animate-pulse flex-col gap-8">
      <span className="sr-only">Loading</span>
      <div className="flex items-center justify-between">
        <div className="h-9 w-48 rounded-lg bg-zinc-200" />
        <div className="h-12 w-32 rounded-xl bg-zinc-200" />
      </div>
      <div className={`${card} divide-y divide-zinc-200`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between px-5 py-5">
            <div className="flex flex-col gap-2">
              <div className="h-5 w-40 rounded bg-zinc-200" />
              <div className="h-4 w-24 rounded bg-zinc-100" />
            </div>
            <div className="h-8 w-24 rounded-lg bg-zinc-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
