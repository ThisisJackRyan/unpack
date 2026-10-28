import { Svg, type IllustrationProps } from "./svg";

// A magnifying glass with a shine on the lens.
export function Magnifier({ className = "h-28 w-28" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 120 120" className={className}>
      <ellipse cx="60" cy="110" rx="40" ry="6" className="fill-primary-100" />
      <path d="M76 76l26 26" className="stroke-ink-900" strokeWidth="16" />
      <path d="M76 76l26 26" className="stroke-primary-500" strokeWidth="9" />
      <circle cx="50" cy="48" r="34" className="fill-lagoon-100 stroke-ink-900" strokeWidth="4" />
      <circle cx="50" cy="48" r="25" className="stroke-lagoon-300" strokeWidth="4" />
      <path d="M34 38c3-7 9-11 16-12" className="stroke-white" strokeWidth="5" />
      <path
        d="M98 6c1 5.5 2.5 7 8 8-5.5 1-7 2.5-8 8-1-5.5-2.5-7-8-8 5.5-1 7-2.5 8-8Z"
        className="fill-sunny-300 stroke-ink-900"
        strokeWidth="2.5"
      />
    </Svg>
  );
}
