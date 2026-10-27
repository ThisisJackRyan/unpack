import { Svg, type IllustrationProps } from "./svg";

// The logo's mark: an open box with a book peeking out and a sparkle,
// drawn by hand for unpack.
export function LogoMark({ className = "h-8 w-8" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 40 40" className={className}>
      <path d="M6 18 1 11.5l8-3.5 3 10M34 18l5-6.5-8-3.5-3 10" className="fill-primary-300" />
      <path d="M12 19v-9.5c2.7-1.3 5.4-1.3 8 .5 2.6-1.8 5.3-1.8 8-.5V19Z" className="fill-white stroke-primary-800" strokeWidth="1.6" />
      <path d="M20 10v9" className="stroke-primary-800" strokeWidth="1.6" />
      <path d="M6 18h28v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3Z" className="fill-primary-600" />
      <path d="M14 27h12" className="stroke-primary-200" strokeWidth="2.4" />
      <path d="M33 1.5c.6 3.2 1.4 4 4.6 4.6-3.2.6-4 1.4-4.6 4.6-.6-3.2-1.4-4-4.6-4.6 3.2-.6 4-1.4 4.6-4.6Z" className="fill-sunny-400" />
    </Svg>
  );
}
