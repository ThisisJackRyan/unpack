"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { TURNSTILE_ACTION, TURNSTILE_RESPONSE_FIELD, TURNSTILE_SCRIPT_URL } from "@/lib/join-bot-check";

// The bot check on the join form: Cloudflare Turnstile, rendered only when
// the check is on (the page passes a site key). It puts its token in a
// hidden input named TURNSTILE_RESPONSE_FIELD inside the form, which the
// join action verifies (src/lib/join-bot-check.ts).
//
// Explicit rendering (render=explicit), so it works when the form mounts
// after the script has loaded (a client navigation back to /join), and
// can be reset: a token is single use, so after every submit (`resetKey`
// changes with each result) the widget gets a fresh one.

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function TurnstileWidget({ siteKey, resetKey }: { siteKey: string; resetKey: unknown }) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(() => typeof window !== "undefined" && Boolean(window.turnstile));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const api = window.turnstile;
    if (!loaded || !api || !container.current) return;
    widgetId.current = api.render(container.current, {
      sitekey: siteKey,
      action: TURNSTILE_ACTION,
      "response-field-name": TURNSTILE_RESPONSE_FIELD,
      theme: "light",
      size: "flexible",
      "error-callback": () => setFailed(true),
      callback: () => setFailed(false),
    });
    return () => {
      if (widgetId.current) api.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [loaded, siteKey]);

  // A fresh token after each submit (the last one was used up).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (widgetId.current) window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  return (
    <div className="flex flex-col gap-2">
      <Script src={TURNSTILE_SCRIPT_URL} strategy="afterInteractive" onReady={() => setLoaded(true)} onError={() => setFailed(true)} />
      {/* Turnstile labels its own frame for screen readers. */}
      <div ref={container} className="min-h-[65px]" />
      <p aria-live="polite" className="text-base font-medium text-red-700 empty:hidden">
        {failed ? "The check didn’t load. Refresh the page and try again." : ""}
      </p>
    </div>
  );
}
