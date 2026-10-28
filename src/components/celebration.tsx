"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BURST_STARS, browserSessionStore, passLine, takeJustChecked } from "@/lib/celebration";

const STAR = "M12 2.5l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 16.8 6.2 20l1.4-6.4L2.7 9.2l6.5-.7Z";

const FILL = {
  sunny: "fill-sunny-300",
  lagoon: "fill-lagoon-300",
  primary: "fill-primary-400",
} as const;

// How much of the celebration is on screen before the burst plays.
const VISIBLE_SHARE = 0.6;

// On a passed reading: a burst of stars around a big one, once, and a
// short encouraging line. The questions sit below the reading text, so the
// burst waits until the celebration is on screen (it used to play, unseen,
// above or below the view), and right after a passing check the
// celebration scrolls into view. CSS animation (the burst keyframes in
// globals.css), motion-safe only: under reduced motion the stars just sit
// where the burst would have put them, and the scroll jumps. Decorative,
// so hidden from screen readers; the line is plain text (the page's live
// region already says "passed").
export function PassCelebration({ tryNumber, readingId }: { tryNumber: number | null | undefined; readingId: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (takeJustChecked(browserSessionStore(), readingId)) {
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    }
    if (typeof IntersectionObserver === "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no observer: play at once
      setPlay(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPlay(true);
          observer.disconnect();
        }
      },
      { threshold: VISIBLE_SHARE },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [readingId]);

  // Before it plays, the stars wait unseen (motion only), so they don't
  // flash at the end spot first.
  const motion = play ? "motion-safe:animate-burst" : "motion-safe:opacity-0";
  const popMotion = play ? "motion-safe:animate-pop" : "motion-safe:opacity-0";

  return (
    <div
      ref={box}
      data-celebration={play ? "played" : "waiting"}
      className="flex scroll-my-8 items-center gap-5 rounded-3xl border-2 border-sunny-200 bg-sunny-50 px-5 py-4"
    >
      <div aria-hidden="true" className="relative h-24 w-24 shrink-0">
        {BURST_STARS.map((star, i) => (
          <svg
            key={i}
            viewBox="0 0 24 24"
            width={star.size}
            height={star.size}
            className={`absolute top-1/2 left-1/2 ${FILL[star.color]} stroke-ink-900 ${motion}`}
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
          className={`absolute top-1/2 left-1/2 -mt-5 -ml-5 h-10 w-10 fill-sunny-400 stroke-ink-900 ${popMotion}`}
          strokeWidth={1.5}
        >
          <path d={STAR} />
        </svg>
      </div>
      <p className="text-xl font-semibold text-ink-950">{passLine(tryNumber)}</p>
    </div>
  );
}
