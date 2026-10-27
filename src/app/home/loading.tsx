import { AuthFrame } from "@/components/auth-frame";
import { LoadingCard } from "@/components/auth-loading";
import { AUTH_LOADING_COPY } from "@/components/auth-loading-text";

// Right after the email code (or any sign-in), Clerk opens /home, which
// looks up or creates the account before sending it on: the same card as
// the sign-in page, so there is no blank wait.
export default function HomeLoading() {
  return (
    <AuthFrame>
      <LoadingCard title={AUTH_LOADING_COPY.afterAuth} />
    </AuthFrame>
  );
}
