import { Svg, type IllustrationProps } from "./svg";

// A round badge with a star and two ribbons: for a finished reading.
export function StarBadge({ className = "h-28 w-24" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 100 120" className={className}>
      <path d="M32 70 22 112l16-8 10 14 8-40Z" className="fill-primary-500 stroke-ink-900" strokeWidth="3.5" />
      <path d="M68 70l10 42-16-8-10 14-8-40Z" className="fill-lagoon-300 stroke-ink-900" strokeWidth="3.5" />
      <circle cx="50" cy="48" r="38" className="fill-sunny-300 stroke-ink-900" strokeWidth="3.5" />
      <circle cx="50" cy="48" r="28" className="fill-sunny-200" />
      <path
        d="m50 28 6 13 14 1.5-10.5 9.5 3 14L50 59l-12.5 7 3-14L30 42.5 44 41Z"
        className="fill-white stroke-ink-900"
        strokeWidth="3"
      />
    </Svg>
  );
}
