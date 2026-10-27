// The words on /sign-in and /sign-up while Clerk loads, or if it can't.
// No imports, so tests can check the copy.

export const AUTH_LOADING_COPY = {
  signIn: "Getting sign-in ready…",
  signUp: "Getting sign-up ready…",
  hint: "This only takes a moment.",
  failedTitle: "This page didn’t load.",
  failedBody: "Check your connection, then reload the page to try again.",
} as const;

export type AuthLoadingKind = "signIn" | "signUp";
