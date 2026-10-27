import type { CSSProperties } from "react";
import { BURST_STARS, passLine } from "@/lib/celebration";

const STAR = "M12 2.5l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20l1.4-6.4L2.7 9.2l6.5-.7Z";

const FILL = {
  sunny: "fill-sunny-300",
  lagoon: "fill-lagoon-300",
  primary: "fill-primary-400",
} as const;

// On a passed reading: a burst of stars around a big one, once, and a
// short encouraging line. CSS only (the burst keyframes in globals.css),
// motion-safe only: under reduced motion the stars just sit where the
// burst would have put them. Decorative, so hidden from screen readers;
// the line is plain text (the page's live region already says "passed").
export function PassCelebration({ tryNumber }: { tryNumber: number | null | undefined }) {
  return (
    <div className="flex items-center gap-5 rounded-3xl border-2 border-sunny-200 bg-sunny-50 px-5 py-4">
      <div aria-hidden="true" className="relative h-24 w-24 shrink-0">
        {BURST_STARS.map((star, i) => (
          <svg
            key={i}
            viewBox="0 0 24 24"
            width={star.size}
            height={star.size}
            className={`absolute top-1/2 left-1/2 ${FILL[star.color]} stroke-ink-900 motion-safe:animate-burst`}
            strokeWidth={1.5}
            style={
              {
                "--tx": `${star.x}px`,
                "--ty": `${star.y}px`,
                marginLeft: -star.size / 2,
                marginTop: -star.size / 2,
                transform: "translate(var(--tx), var(--ty))",
                animationDelay: `${star.delayMs}ms`,
              } as CSSProperties
            }
          >
            <path d={STAR} />
          </svg>
        ))}
        <svg
          viewBox="0 0 24 24"
          className="absolute top-1/2 left-1/2 -mt-5 -ml-5 h-10 w-10 fill-sunny-400 stroke-ink-900 motion-safe:animate-pop"
          strokeWidth={1.5}
        >
          <path d={STAR} />
        </svg>
      </div>
      <p className="text-xl font-semibold text-ink-950">{passLine(tryNumber)}</p>
    </div>
  );
}
