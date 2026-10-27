"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpFromHeaders, hashJoinIp } from "@/lib/client-ip";
import { verifyJoinBotCheck } from "@/lib/join-bot-check";
import { JOIN_LIMITED_MESSAGE } from "@/lib/join-rate-limit";
import { joinClass } from "@/lib/student-join";
import { NAME_TAKEN_MESSAGE, type JoinOutcome } from "@/lib/student-join-core";
import { setStudentSessionCookie } from "@/lib/student-session";
import { CLASS_NOT_FOUND_MESSAGE, validateJoin } from "@/lib/validate-join";
import type { JoinState } from "./form-state";

const JOIN_FAILED_MESSAGE = "We couldn’t join you to the class. Please try again.";

// Joins a class and starts the student's session. Joining while already in
// a class (the form is still on /join for that) replaces the cookie: this
// browser then belongs to the new student. The old student row and its
// work stay, for the teacher.
export async function joinClassAction(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const result = validateJoin({
    code: formData.get("code"),
    firstName: formData.get("firstName"),
    lastInitials: formData.get("lastInitials"),
  });
  if (!result.ok) return { errors: result.errors, values: result.values };
  const { data, values } = result;

  const requestHeaders = await headers();
  let outcome: JoinOutcome;
  try {
    // Throws in production when JOIN_IP_HASH_SECRET is missing or short, so
    // the join fails closed with the generic message below.
    const ipHash = hashJoinIp(clientIpFromHeaders((name) => requestHeaders.get(name)));
    // A no-op until the abuse PR replaces it.
    await verifyJoinBotCheck({ ipHash });
    outcome = await joinClass(data, ipHash);
  } catch (error) {
    // Name, code, and message only: a Postgres error's detail can echo the
    // row, including the student's name.
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    console.error("joinClassAction: join failed", { name, code, message });
    return { errors: { form: JOIN_FAILED_MESSAGE }, values };
  }

  switch (outcome.status) {
    case "limited":
      return { errors: { form: JOIN_LIMITED_MESSAGE }, values };
    case "class_not_found":
      return { errors: { code: CLASS_NOT_FOUND_MESSAGE }, values };
    case "name_taken":
      return { errors: { lastInitials: NAME_TAKEN_MESSAGE }, values };
  }

  await setStudentSessionCookie(outcome.token);
  // redirect() throws, so it stays outside the try above.
  redirect("/c");
}
