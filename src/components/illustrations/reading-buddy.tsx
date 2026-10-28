import { Svg, type IllustrationProps } from "./svg";

// A round, friendly reading buddy holding a book. Plain shapes, no face
// details beyond two eyes and a smile.
export function ReadingBuddy({ className = "h-36 w-36" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 160 160" className={className}>
      <ellipse cx="80" cy="148" rx="50" ry="7" className="fill-primary-100" />
      <path
        d="M80 20c34 0 52 26 52 62 0 34-20 58-52 58s-52-24-52-58c0-36 18-62 52-62Z"
        className="fill-lagoon-300 stroke-ink-900"
        strokeWidth="3.5"
      />
      <path d="M52 30c-4-10-2-18 4-22M108 30c4-10 2-18-4-22" className="stroke-ink-900" strokeWidth="3.5" />
      <circle cx="56" cy="8" r="5" className="fill-sunny-300 stroke-ink-900" strokeWidth="3" />
      <circle cx="104" cy="8" r="5" className="fill-sunny-300 stroke-ink-900" strokeWidth="3" />
      <circle cx="64" cy="62" r="6" className="fill-ink-900" />
      <circle cx="96" cy="62" r="6" className="fill-ink-900" />
      <circle cx="66" cy="60" r="2" className="fill-white" />
      <circle cx="98" cy="60" r="2" className="fill-white" />
      <path d="M70 78c6 6 14 6 20 0" className="stroke-ink-900" strokeWidth="3.5" />
      <circle cx="50" cy="76" r="6" className="fill-sunny-200" />
      <circle cx="110" cy="76" r="6" className="fill-sunny-200" />
      <path d="M80 104c-12-8-26-9-40-6v32c14-3 28-2 40 6Z" className="fill-white stroke-ink-900" strokeWidth="3.5" />
      <path d="M80 104c12-8 26-9 40-6v32c-14-3-28-2-40 6Z" className="fill-primary-200 stroke-ink-900" strokeWidth="3.5" />
      <path d="M80 104v32" className="stroke-ink-900" strokeWidth="3" />
    </Svg>
  );
}
