import "server-only";
import { cookies } from "next/headers";
import { AGE_GATE_COOKIE, AGE_GATE_VALUE, ageGateCookieOptions, isAgeGated } from "./age-screen";
import { isProduction } from "./env";

// Server-only: the age gate cookie (see age-screen.ts). It holds only
// "under", never a date or an age.

export async function readAgeGate(): Promise<boolean> {
  const store = await cookies();
  return isAgeGated(store.get(AGE_GATE_COOKIE)?.value);
}

export async function setAgeGate(): Promise<void> {
  const store = await cookies();
  store.set(AGE_GATE_COOKIE, AGE_GATE_VALUE, ageGateCookieOptions(isProduction()));
}
