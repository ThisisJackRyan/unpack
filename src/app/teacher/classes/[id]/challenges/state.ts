// Shared by the queue's action and client component. Kept out of
// actions.ts because a "use server" file may only export async functions.

import type { DecideResult } from "@/lib/challenge-queue-core";

export type DecideState = {
  // The challenge the result belongs to.
  challengeId?: string;
  result?: DecideResult;
  // A save that failed (nothing was decided); the card stays.
  error?: string;
};
