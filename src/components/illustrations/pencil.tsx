import { Svg, type IllustrationProps } from "./svg";

// A sunny pencil writing on a line, tip down to the right.
export function Pencil({ className = "h-12 w-12" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 48 48" className={className}>
      <path d="M6 42h24" className="stroke-primary-300" strokeWidth="3" />
      <path d="M33 5l10 10-21 21-10-10L33 5Z" className="fill-sunny-300 stroke-ink-900" strokeWidth="2.5" />
      <path d="M33 5l10 10-4 4-10-10 4-4Z" className="fill-primary-300 stroke-ink-900" strokeWidth="2.5" />
      <path d="M12 26l10 10-12 4 2-14Z" className="fill-sunny-100 stroke-ink-900" strokeWidth="2.5" />
      <path d="M10.7 35.3 10 40l4.7-1.3" className="fill-ink-900 stroke-ink-900" strokeWidth="2" />
    </Svg>
  );
}
