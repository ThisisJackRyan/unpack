// Unsent answer drafts, kept in the browser (localStorage) so a reload, a
// closed tab or a dropped connection doesn't lose what a student typed.
// Keys hold ids only and values hold only the answer text: never a name
// or anything else about the student. A draft belongs to one try, so a
// check that saved (the page moves to the next try, or past answering)
// makes the older drafts stale, and they're removed. Every storage call is
// guarded: private mode, a blocked or a full localStorage just means no
// drafts. Pure apart from the storage passed in, so tests cover it.

import { ANSWER_MAX_LENGTH } from "./validate-answers";

// "class": a student in a class (owner = student id). "self": a
// self-learner (owner = account id). The owner keeps two students on one
// classroom device from seeing each other's drafts.
export type DraftMode = "class" | "self";

export type DraftOwner = { mode: DraftMode; readingId: string; ownerId: string };

export type DraftScope = DraftOwner & { tryNumber: number };

// The part of the Web Storage API used here.
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export const ANSWER_DRAFT_PREFIX = "unpack:answers:v1:";

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
export function saveDraft(storage: DraftStorage | null, scope: DraftScope, questionId: string, text: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(draftKey(scope, questionId), text.slice(0, ANSWER_MAX_LENGTH));
    return true;
  } catch {
    return false;
  }
}

// This try's drafts for the given questions, by question id. A question
// without a draft is left out.
export function loadDrafts(
  storage: DraftStorage | null,
  scope: DraftScope,
  questionIds: readonly string[],
): Record<string, string> {
  const drafts: Record<string, string> = {};
  if (!storage) return drafts;
  for (const id of questionIds) {
    try {
      const text = storage.getItem(draftKey(scope, id));
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
