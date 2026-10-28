import { LoadingCard } from "@/components/auth-loading";
import { AUTH_LOADING_COPY } from "@/components/auth-loading-text";

// The first-run choice right after sign-up, inside the account header.
export default function WelcomeLoading() {
  return (
    <div className="flex justify-center">
      <LoadingCard title={AUTH_LOADING_COPY.afterAuth} />
    </div>
  );
}
