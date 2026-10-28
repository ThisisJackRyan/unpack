// Unsent answer drafts, and the unsent note to the teacher, kept in the
// browser (localStorage) so a reload, a closed tab or a dropped connection
// doesn't lose what a student typed.
// Keys hold ids only and values hold only the answer text and when it was
// saved: never a name or anything else about the student. A draft belongs
// to one try, so a check that saved (the page moves to the next try, or
// past answering) makes the older drafts stale, and they're removed. A
// draft older than DRAFT_TTL_DAYS counts as absent, and pruneDrafts (run
// when a form loads) removes every expired unpack draft on the device, so
// a reading left unfinished doesn't keep its text there for good. Every
// storage call is guarded: private mode, a blocked or a full localStorage
// just means no drafts. Pure apart from the storage and the time passed
// in, so tests cover it.

import { ANSWER_MAX_LENGTH, CHALLENGE_NOTE_MAX_LENGTH } from "./validate-answers";

// "class": a student in a class (owner = student id). "self": a
// self-learner (owner = account id). The owner keeps two students on one
// classroom device from seeing each other's drafts.
export type DraftMode = "class" | "self";

export type DraftOwner = { mode: DraftMode; readingId: string; ownerId: string };

export type DraftScope = DraftOwner & { tryNumber: number };

// The part of the Web Storage API used here.
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const ANSWER_DRAFT_PREFIX = "unpack:answers:v1:";

export const DRAFT_TTL_DAYS = 7;
const DRAFT_TTL_MS = DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;

// The stored value: {"savedAt": epoch ms, "text": the text}. A value in
// the earlier format (the bare text, no time) still loads, as if saved
// now; pruneDrafts stamps it with the time it first sees it, so it
// expires DRAFT_TTL_DAYS after that. A savedAt in the future (the clock
// was ahead when it was saved, or someone edited it) is read as saved
// now, and pruneDrafts re-stamps it with now, so a wrong clock can't keep
// a draft fresh for good.
export function encodeDraft(text: string, now: number): string {
  return JSON.stringify({ savedAt: now, text });
}

type DecodedDraft = { text: string; savedAt: number | null };

export function decodeDraft(raw: string): DecodedDraft {
  if (raw.startsWith("{")) {
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === "object") {
        const { savedAt, text } = value as { savedAt?: unknown; text?: unknown };
        if (typeof savedAt === "number" && Number.isFinite(savedAt) && typeof text === "string") return { text, savedAt };
      }
    } catch {
      // Not ours: the bare text of an earlier draft.
    }
  }
  return { text: raw, savedAt: null };
}

// savedAt clamped to now: a future time counts as saved now.
function savedAtOrNow(draft: DecodedDraft, now: number): number {
  return draft.savedAt === null ? now : Math.min(draft.savedAt, now);
}

function isExpired(draft: DecodedDraft, now: number): boolean {
  return now - savedAtOrNow(draft, now) > DRAFT_TTL_MS;
}

// The draft's text, or null when there is none or it has expired.
function readDraft(storage: DraftStorage, key: string, now: number): string | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const draft = decodeDraft(raw);
  return isExpired(draft, now) ? null : draft.text;
}

// unpack:answers:v1:<mode>:<reading id>:<owner id>:
export function draftOwnerPrefix(owner: DraftOwner): string {
  return `${ANSWER_DRAFT_PREFIX}${owner.mode}:${owner.readingId}:${owner.ownerId}:`;
}

// unpack:answers:v1:<mode>:<reading id>:<owner id>:t<try>:<question id>
export function draftKey(scope: DraftScope, questionId: string): string {
  return `${draftOwnerPrefix(scope)}t${scope.tryNumber}:${questionId}`;
}

// localStorage, or null where it can't be used (no window, blocked
// storage, private mode that throws on write).
export function browserDraftStorage(): DraftStorage | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = window.localStorage;
    const probe = `${ANSWER_DRAFT_PREFIX}probe`;
    storage.setItem(probe, "");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

// Saves one answer's draft. False when it couldn't be saved (full or
// unavailable storage); the answer box keeps working either way.
export function saveDraft(
  storage: DraftStorage | null,
  scope: DraftScope,
  questionId: string,
  text: string,
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(draftKey(scope, questionId), encodeDraft(text.slice(0, ANSWER_MAX_LENGTH), now));
    return true;
  } catch {
    return false;
  }
}

// This try's drafts for the given questions, by question id. A question
// without a draft (or with an expired one) is left out.
export function loadDrafts(
  storage: DraftStorage | null,
  scope: DraftScope,
  questionIds: readonly string[],
  now: number = Date.now(),
): Record<string, string> {
  const drafts: Record<string, string> = {};
  if (!storage) return drafts;
  for (const id of questionIds) {
    try {
      const text = readDraft(storage, draftKey(scope, id), now);
      if (text !== null) drafts[id] = text.slice(0, ANSWER_MAX_LENGTH);
    } catch {
      // Unreadable: no draft for this one.
    }
  }
  return drafts;
}

// Removes the owner's drafts on this reading, all of them or every try's
// but `keepTry`. Returns how many were removed.
export function clearDrafts(storage: DraftStorage | null, owner: DraftOwner, keepTry?: number): number {
  if (!storage) return 0;
  const prefix = draftOwnerPrefix(owner);
  const keep = keepTry === undefined ? null : `${prefix}t${keepTry}:`;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix) && !(keep && key.startsWith(keep))) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return stale.length;
  } catch {
    return 0;
  }
}

// Removes every expired answer and note draft on this device (any reading,
// any owner), and stamps earlier-format drafts, and drafts saved "in the
// future", with `now`. Returns how many were removed.
export function pruneDrafts(storage: DraftStorage | null, now: number = Date.now()): number {
  if (!storage) return 0;
  try {
    const expired: string[] = [];
    const unstamped: [string, string][] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !(key.startsWith(ANSWER_DRAFT_PREFIX) || key.startsWith(NOTE_DRAFT_PREFIX))) continue;
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const draft = decodeDraft(raw);
      if (isExpired(draft, now)) expired.push(key);
      else if (draft.savedAt === null || draft.savedAt > now) unstamped.push([key, draft.text]);
    }
    for (const key of expired) storage.removeItem(key);
    for (const [key, text] of unstamped) storage.setItem(key, encodeDraft(text, now));
    return expired.length;
  } catch {
    return 0;
  }
}

// The answer boxes' starting values: the page's prefill (the last try's
// answers), with this try's drafts on top for the questions that can
// still be edited. A draft is always newer than the prefill, because it
// was typed during this try, after the last try was saved.
export function withDrafts(
  prefill: Record<string, string>,
  drafts: Record<string, string>,
  editableIds: readonly string[],
): Record<string, string> {
  const next = { ...prefill };
  for (const id of editableIds) {
    if (Object.hasOwn(drafts, id)) next[id] = drafts[id];
  }
  return next;
}

// The note to the teacher (the challenge note), one per reading and
// student, in its own key space so clearing the answer drafts (which
// happens on the very page that shows the note box) leaves it alone. The
// value is the note text and when it was saved, and it expires like an
// answer draft. Cleared once the note is sent, and when the
// page no longer offers the note box (sent from another tab, decided, or
// passed).
export const NOTE_DRAFT_PREFIX = "unpack:note:v1:";

// unpack:note:v1:<mode>:<reading id>:<owner id>
export function noteDraftKey(owner: DraftOwner): string {
  return `${NOTE_DRAFT_PREFIX}${owner.mode}:${owner.readingId}:${owner.ownerId}`;
}

// False when it couldn't be saved; an empty note is saved too, so a
// cleared note stays cleared after a reload.
export function saveNoteDraft(
  storage: DraftStorage | null,
  owner: DraftOwner,
  text: string,
  now: number = Date.now(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(noteDraftKey(owner), encodeDraft(text.slice(0, CHALLENGE_NOTE_MAX_LENGTH), now));
    return true;
  } catch {
    return false;
  }
}

// The saved note, or null when there is none (or it has expired, or it
// can't be read).
export function loadNoteDraft(storage: DraftStorage | null, owner: DraftOwner, now: number = Date.now()): string | null {
  if (!storage) return null;
  try {
    const text = readDraft(storage, noteDraftKey(owner), now);
    return text === null ? null : text.slice(0, CHALLENGE_NOTE_MAX_LENGTH);
  } catch {
    return null;
  }
}

export function clearNoteDraft(storage: DraftStorage | null, owner: DraftOwner): void {
  if (!storage) return;
  try {
    storage.removeItem(noteDraftKey(owner));
  } catch {
    // Blocked storage: nothing was saved either.
  }
}
