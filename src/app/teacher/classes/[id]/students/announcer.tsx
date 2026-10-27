"use client";

import { useEffect, useState } from "react";

// Fired when a row action finishes (a delete, a "Let them try again"):
// the row's button is gone after the refresh, so the message lives above
// the list, in ProgressAnnouncer.
const ANNOUNCE_EVENT = "unpack:progress-announce";

export function announceProgress(message: string) {
  window.dispatchEvent(new CustomEvent(ANNOUNCE_EVENT, { detail: message }));
}

// The page's live region for row actions. Stays mounted while rows come
// and go, and moves focus to the heading so it isn't lost with the button.
export function ProgressAnnouncer({ headingId }: { headingId: string }) {
  const [message, setMessage] = useState("");

  useEffect(() => {
    function onAnnounce(e: Event) {
      setMessage((e as CustomEvent<string>).detail);
      document.getElementById(headingId)?.focus();
    }
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    return () => window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
  }, [headingId]);

  return (
    <p
      aria-live="polite"
      className="rounded-xl border border-primary-200 bg-primary-50 px-5 py-3 text-base font-medium text-primary-950 empty:hidden"
    >
      {message}
    </p>
  );
}
