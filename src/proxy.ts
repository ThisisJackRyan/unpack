import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Account routes require a Clerk session: the teacher area, the
// self-learner area (/learn), the first-run choice (/welcome), settings,
// and /home (which sends each account to its home). Which role may use
// which area is checked on the server by every page and action (see
// src/lib/account.ts); this only makes sure someone is signed in.
// Student routes (/join, /c/..., /api/student/...) and the landing page
// stay public: students have no accounts.
// /api/webhooks/clerk stays public too: Clerk calls it with no session, and
// the route verifies Clerk's signature itself (src/lib/clerk-webhook.ts).
// Keep it out of isAccountRoute.
const isAccountRoute = createRouteMatcher([
  "/teacher(.*)",
  "/api/teacher(.*)",
  "/learn(.*)",
  "/welcome(.*)",
  "/settings(.*)",
  "/home(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isAccountRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
