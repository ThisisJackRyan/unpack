import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { ACCOUNT_ROUTE_PATTERNS, SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth-routes";

// Account routes require a Clerk session: the teacher area, the
// self-learner area (/learn), the first-run choice (/welcome), settings,
// and /home (which sends each account to its home). Which role may use
// which area is checked on the server by every page and action (see
// src/lib/account.ts); this only makes sure someone is signed in.
// Student routes (/join, /c/..., /api/student/...) and the landing page
// stay public: students have no accounts.
// /api/webhooks/clerk stays public too: Clerk calls it with no session, and
// the route verifies Clerk's signature itself (src/lib/clerk-webhook.ts).
// Keep it out of isAccountRoute. So is /account-deleted, where a deleted
// account's leftover session lands (it never loads the account), and so
// are the in-app sign-in and sign-up pages (/sign-in, /sign-up and their
// sub-steps): auth-routes.test.ts checks they stay public.
const isAccountRoute = createRouteMatcher(ACCOUNT_ROUTE_PATTERNS);

export default clerkMiddleware(
  async (auth, req) => {
    if (isAccountRoute(req)) {
      await auth.protect();
    }
  },
  // A signed-out visit to an account route goes to our own /sign-in page,
  // even if NEXT_PUBLIC_CLERK_SIGN_IN_URL isn't set on the deploy.
  { signInUrl: SIGN_IN_PATH, signUpUrl: SIGN_UP_PATH },
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
