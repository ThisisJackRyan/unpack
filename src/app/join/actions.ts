"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { verifyJoinBotCheck } from "@/lib/join-bot-check";
import { requestRetryClock } from "@/lib/request-time-zone";
import { joinClass } from "@/lib/student-join";
import { setStudentSessionCookie } from "@/lib/student-session";
import type { JoinState } from "./form-state";
import { joinClassCore } from "./join-core";

// Joins a class and starts the student's session. Joining while already in
// a class (the form is still on /join for that) replaces the cookie: this
// browser then belongs to the new student. The old student row and its
// work stay, for the teacher. The steps, in order, are in join-core.ts:
// form validation, the server setup check, the bot check, then the rate
// limits and the insert.
export async function joinClassAction(_prev: JoinState, formData: FormData): Promise<JoinState> {
  const result = await joinClassCore(formData, {
    verifyBotCheck: (token) =>
      verifyJoinBotCheck(
        { token },
        { onFailure: (fields) => console.error("joinClassAction: bot check refused", fields) },
      ),
    requestHeaders: async () => {
      const requestHeaders = await headers();
      return (name) => requestHeaders.get(name);
    },
    joinClass,
    retryClock: requestRetryClock,
  });
  if ("state" in result) return result.state;

  await setStudentSessionCookie(result.joined.token);
  // redirect() throws, so it stays outside joinClassCore's try.
  redirect("/c");
}
