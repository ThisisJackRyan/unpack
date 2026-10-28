// The QA answer form's saved tries, per ?run= id, so a check can move the
// page to a new try as a saved check does: the last try comes back as a
// failed attempt with its answers, like the reading pages' `previous`. In
// memory (one `next start` for the browser check), on globalThis so the
// page and the action see the same map. QA only (the script's fixed
// answers, nothing real): see src/lib/qa-routes.ts.

import type { AttemptView } from "@/lib/reading-progress";

const store = globalThis as typeof globalThis & { __unpackQaTries?: Map<string, AttemptView> };

function tries(): Map<string, AttemptView> {
  store.__unpackQaTries ??= new Map();
  return store.__unpackQaTries;
}

export function qaLastTry(run: string): AttemptView | null {
  return tries().get(run) ?? null;
}

export function saveQaTry(run: string, texts: Record<string, string>): void {
  const answers = Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, { text, pass: false, nudge: "QA tip." }]));
  tries().set(run, { tryNumber: (qaLastTry(run)?.tryNumber ?? 0) + 1, result: "fail", answers });
}
