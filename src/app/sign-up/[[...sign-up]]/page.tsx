import { SignUp } from "@clerk/nextjs";

// Teacher sign-up. Its bot check is Clerk's own "Bot sign-up protection"
// (Cloudflare Turnstile, turned on in the Clerk dashboard), which the
// prebuilt <SignUp /> renders inside itself; nothing to add here. Our own
// Turnstile keys cover the student join form only. A custom sign-up flow
// (instead of <SignUp />) would need <div id="clerk-captcha" /> in its form.
export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <SignUp />
    </main>
  );
}
