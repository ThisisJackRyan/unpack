import { CheckIcon } from "./answer-parts";

// The result banner on a reading page (student and self-learner): green
// with a check when done, indigo otherwise. Never red: nothing here is an
// error.
export function Banner({ tone, title, children }: { tone: "done" | "info"; title: string; children: React.ReactNode }) {
  const done = tone === "done";
  return (
    <div
      className={`flex gap-4 rounded-2xl border px-5 py-5 ${
        done ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-indigo-200 bg-indigo-50 text-indigo-950"
      }`}
    >
      {done && (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white">
          <CheckIcon className="h-6 w-6" />
        </span>
      )}
      <div className="flex flex-col gap-1">
        <p className="text-xl font-semibold">{title}</p>
        <p className="text-lg">{children}</p>
      </div>
    </div>
  );
}
