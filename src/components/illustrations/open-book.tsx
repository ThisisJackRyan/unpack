import { Svg, type IllustrationProps } from "./svg";

// An open book with a few lines on each page and a sparkle above.
export function OpenBook({ className = "h-32 w-40" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 160 128" className={className}>
      <ellipse cx="80" cy="116" rx="60" ry="7" className="fill-primary-100" />
      <path d="M80 36c-14-10-36-12-60-8v76c24-4 46-2 60 8Z" className="fill-white stroke-ink-900" strokeWidth="3.5" />
      <path d="M80 36c14-10 36-12 60-8v76c-24-4-46-2-60 8Z" className="fill-primary-50 stroke-ink-900" strokeWidth="3.5" />
      <path d="M20 104c24-4 46-2 60 8 14-10 36-12 60-8" className="stroke-primary-500" strokeWidth="5" />
      <path d="M32 48c13-2 26-1 36 4M32 62c13-2 26-1 36 4M32 76c9-1 18-1 26 2" className="stroke-primary-300" strokeWidth="4" />
      <path d="M92 52c10-5 23-6 36-4M92 66c10-5 23-6 36-4M92 80c8-3 16-4 24-3" className="stroke-lagoon-300" strokeWidth="4" />
      <path
        d="M118 4c1.2 7 3.2 9 10 10-6.8 1-8.8 3-10 10-1.2-7-3.2-9-10-10 6.8-1 8.8-3 10-10Z"
        className="fill-sunny-300 stroke-ink-900"
        strokeWidth="2.5"
      />
      <circle cx="44" cy="18" r="3.5" className="fill-lagoon-300" />
    </Svg>
  );
}
