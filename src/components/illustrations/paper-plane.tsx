import { Svg, type IllustrationProps } from "./svg";

// A folded paper plane with a looping dashed trail.
export function PaperPlane({ className = "h-28 w-36" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 150 110" className={className}>
      <path
        d="M8 92c14 6 30 4 36-6 6-10-6-18-14-10-8 8 6 18 22 14 12-3 22-10 30-18"
        className="stroke-primary-300"
        strokeWidth="3.5"
        strokeDasharray="2 9"
      />
      <path d="M142 10 64 46l26 10Z" className="fill-white stroke-ink-900" strokeWidth="3.5" />
      <path d="M142 10 90 56l8 32Z" className="fill-primary-200 stroke-ink-900" strokeWidth="3.5" />
      <path d="M90 56l-2 22 10 10" className="fill-primary-400 stroke-ink-900" strokeWidth="3.5" />
      <circle cx="122" cy="76" r="4" className="fill-sunny-300" />
      <circle cx="40" cy="22" r="3" className="fill-lagoon-300" />
    </Svg>
  );
}
