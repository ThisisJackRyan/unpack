// The in-app Clerk pages and the routes that need a Clerk session. Pure
// data, shared by src/proxy.ts, the root layout's ClerkProvider, and the
// landing page, so tests can check that the sign-in and sign-up pages stay
// public.

// Our own pages with Clerk's <SignIn /> and <SignUp /> (catch-all routes
// under src/app/sign-in and src/app/sign-up), never Clerk's hosted pages.
// Also set as NEXT_PUBLIC_CLERK_SIGN_IN_URL and NEXT_PUBLIC_CLERK_SIGN_UP_URL
// in .env.example; the code passes them too, so a deploy without those
// variables still uses these pages.
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";

// Where sign-in and sign-up land when there is no page to go back to:
// /home sends each account to its home (/welcome for a new account, which
// first-run onboarding and the deleted-account refusal both run through).
export const AFTER_AUTH_PATH = "/home";

// Account routes require a Clerk session (createRouteMatcher patterns).
export const ACCOUNT_ROUTE_PATTERNS = [
  "/teacher(.*)",
  "/api/teacher(.*)",
  "/learn(.*)",
  "/welcome(.*)",
  "/settings(.*)",
  "/home(.*)",
];
