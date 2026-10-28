import type { ReactNode } from "react";

// The frame every illustration shares: decorative (hidden from screen
// readers, never focusable), no text inside, sized by `className`.
// Colors are theme tokens via fill-* and stroke-* classes.
export type IllustrationProps = { className?: string };

export function Svg({ viewBox, className, children }: { viewBox: string; className?: string; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={viewBox}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  );
}
