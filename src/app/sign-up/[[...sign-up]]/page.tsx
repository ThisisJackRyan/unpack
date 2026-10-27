import { SignUp } from "@clerk/nextjs";
import { AFTER_AUTH_PATH } from "@/lib/auth-routes";

// Account sign-up (teachers and self-learners; the role is chosen next,
// on /welcome, where /home sends a new account). Its bot check is Clerk's own "Challenge suspicious
// sign-ups" (Clerk Dashboard, Protect, Protections; on by default for new
// apps): a Cloudflare Turnstile challenge for suspicious sign-ups, which
// the prebuilt <SignUp /> shows inside itself, so nothing to add here.
// Our own Turnstile keys cover the student join form only. See
// docs/v1-spec.md for exactly what it covers. (A custom flow on Clerk's
// legacy "Bot sign-up protection" would need <div id="clerk-captcha" />.)
export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <SignUp fallbackRedirectUrl={AFTER_AUTH_PATH} />
    </main>
  );
}
