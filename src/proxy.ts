import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Only teacher routes require a Clerk session. Student routes (/join, /c/...,
// /api/student/...) and the landing page stay public: students have no accounts.
// /api/webhooks/clerk stays public too: Clerk calls it with no session, and
// the route verifies Clerk's signature itself (src/lib/clerk-webhook.ts).
// Keep it out of isTeacherRoute.
const isTeacherRoute = createRouteMatcher(["/teacher(.*)", "/api/teacher(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isTeacherRoute(req)) {
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
