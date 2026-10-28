import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono, Nunito } from "next/font/google";
import { ClerkAvatarAlt } from "@/components/clerk-avatar-alt";
import { AFTER_AUTH_PATH, AFTER_SIGN_OUT_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth-routes";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { clerkLocalization } from "@/lib/clerk-localization";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Headings, buttons and the wordmark: Nunito, a rounded face (SIL Open
// Font License 1.1). next/font downloads it at build time and serves it
// from our own origin, so nothing is fetched from Google at runtime. Body
// text and the reading passages stay in Geist.
const nunito = Nunito({
  variable: "--font-nunito",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "unpack",
    template: "%s | unpack",
  },
  description:
    "Students read, then answer AI-generated questions about the text. They move on only when they've genuinely tried.",
  applicationName: "unpack",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning (this element's own attributes only, not its
    // children): browser extensions add attributes to <html> and <body>
    // before React hydrates, which logged a hydration error.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${nunito.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {/* Clerk's links between sign-in and sign-up stay on our own pages,
            signing out lands on our landing page, and its components wear
            the app's colors, radius and type. Telemetry is off: nothing
            about our pages goes to Clerk's telemetry service, and its
            requests (blocked by many browser privacy tools) no longer log
            console errors. The account menu button is named "Account
            menu". */}
        <ClerkProvider
          appearance={clerkAppearance}
          localization={clerkLocalization}
          signInUrl={SIGN_IN_PATH}
          signUpUrl={SIGN_UP_PATH}
          signInFallbackRedirectUrl={AFTER_AUTH_PATH}
          signUpFallbackRedirectUrl={AFTER_AUTH_PATH}
          afterSignOutUrl={AFTER_SIGN_OUT_PATH}
          telemetry={false}
        >
          {children}
          {/* Clerk's avatar alt is "'s logo" for an account with no name. */}
          <ClerkAvatarAlt />
        </ClerkProvider>
      </body>
    </html>
  );
}
