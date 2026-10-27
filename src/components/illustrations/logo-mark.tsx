import { Svg, type IllustrationProps } from "./svg";

// The small mark beside the "unpack" word in headers: an open box with a
// sparkle coming out.
export function LogoMark({ className = "h-8 w-8" }: IllustrationProps) {
  return (
    <Svg viewBox="0 0 40 40" className={className}>
      <path d="M6 18h28v16a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3Z" className="fill-primary-600" />
      <path d="M6 18 2 11l14-3 4 10M34 18l4-7-14-3-4 10" className="fill-primary-300" />
      <path d="M20 1.5c.7 4 1.8 5.1 5.8 5.8-4 .7-5.1 1.8-5.8 5.8-.7-4-1.8-5.1-5.8-5.8 4-.7 5.1-1.8 5.8-5.8Z" className="fill-sunny-400" />
    </Svg>
  );
}
