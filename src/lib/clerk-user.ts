import { isNotFound } from "./under-13-account";

// Loads the Clerk user (currentUser) for a session that may have outlived
// its account: the session token is checked locally, so it can still name
// a user Clerk has just deleted (an under-13 delete, or the dashboard).
// Clerk then answers 404, which is no user here (null), not an error, so
// the caller sends the visitor to sign in instead of the page crashing.
// Any other error is thrown as before.
export async function clerkUserOrNull<T>(load: () => Promise<T | null>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
