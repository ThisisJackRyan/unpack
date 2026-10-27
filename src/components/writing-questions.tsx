import { Pencil } from "./illustrations";
import { WRITING_YOUR_QUESTIONS } from "./writing-questions-text";

// Shown instead of grey skeleton cards while questions are written: a
// pencil that bobs as it writes and three hopping dots, both still under
// prefers-reduced-motion. The line is stable text; with `announce` (the
// default) it is a status region, read out once. Pass announce={false}
// where the page already has a status region saying the same.
export function WritingQuestions({
  label = WRITING_YOUR_QUESTIONS,
  announce = true,
  size = "large",
}: {
  label?: string;
  announce?: boolean;
  size?: "large" | "small";
}) {
  const large = size === "large";
  return (
    <div
      role={announce ? "status" : undefined}
      className={
        large
          ? "flex items-center gap-5 rounded-3xl border-2 border-dashed border-primary-200 bg-primary-50 px-6 py-8"
          : "flex items-center gap-3 py-1"
      }
    >
      <Pencil className={`${large ? "h-14 w-14" : "h-9 w-9"} shrink-0 motion-safe:animate-pencil`} />
      <p className={`${large ? "text-xl" : "text-base"} font-display font-bold text-primary-950`}>
        {label}
      </p>
      <span aria-hidden="true" className="flex items-end gap-1.5 self-center">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`${large ? "h-2.5 w-2.5" : "h-2 w-2"} rounded-full bg-primary-400 motion-safe:animate-hop`}
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
