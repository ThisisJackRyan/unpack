import { Svg, type IllustrationProps } from "./svg";

// A four-point sparkle, with a smaller one beside it.
export function Sparkle({ className = "h-8 w-8" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 48 48" className={className}>
      <path
        d="M20 4c1.5 9 4 11.5 13 13-9 1.5-11.5 4-13 13-1.5-9-4-11.5-13-13 9-1.5 11.5-4 13-13Z"
        className="fill-sunny-300 stroke-ink-900"
        strokeWidth="2.5"
      />
      <path d="M38 30c.8 4.2 1.8 5.2 6 6-4.2.8-5.2 1.8-6 6-.8-4.2-1.8-5.2-6-6 4.2-.8 5.2-1.8 6-6Z" className="fill-lagoon-300" />
    </Svg>
  );
}
