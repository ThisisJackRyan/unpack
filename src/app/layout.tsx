import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono, Nunito } from "next/font/google";
import { AFTER_AUTH_PATH, SIGN_IN_PATH, SIGN_UP_PATH } from "@/lib/auth-routes";
import { clerkAppearance } from "@/lib/clerk-appearance";
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
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${nunito.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Clerk's links between sign-in and sign-up stay on our own pages,
            and its components wear the app's colors, radius and type. */}
        <ClerkProvider
          appearance={clerkAppearance}
          signInUrl={SIGN_IN_PATH}
          signUpUrl={SIGN_UP_PATH}
          signInFallbackRedirectUrl={AFTER_AUTH_PATH}
          signUpFallbackRedirectUrl={AFTER_AUTH_PATH}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
