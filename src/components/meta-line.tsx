import { Fragment } from "react";
import { META_SEPARATOR, metaParts, metaSpokenText, type MetaPart } from "@/lib/meta-line";

// A reading's meta line. Screen readers get one sentence of the present
// parts, comma separated (sr-only); the dotted line is visual only, so its
// separators never show up in the accessibility tree.
export function MetaLine({ parts, className = "" }: { parts: readonly MetaPart[]; className?: string }) {
  const present = metaParts(parts);
  if (present.length === 0) return null;
  return (
    <p className={`break-words ${className}`}>
      <span className="sr-only">{metaSpokenText(present)}</span>
      <span aria-hidden="true">
        {present.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && META_SEPARATOR}
            {part}
          </Fragment>
        ))}
      </span>
    </p>
  );
}
