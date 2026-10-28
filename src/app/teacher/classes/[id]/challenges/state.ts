// Shared by the queue's action and client component. Kept out of
// actions.ts because a "use server" file may only export async functions.

import type { DecideResult, GrantResult } from "@/lib/challenge-queue-core";

export type DecideState = {
  // The challenge the result belongs to.
  challengeId?: string;
  result?: DecideResult;
  // A save that failed (nothing was decided); the card stays.
  error?: string;
};

export type GrantState = {
  // The no-note row the result belongs to: "<student id>:<reading id>".
  key?: string;
  result?: GrantResult;
  // A save that failed (nothing changed); the row stays.
  error?: string;
};
