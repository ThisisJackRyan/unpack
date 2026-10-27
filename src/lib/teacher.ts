import { cache } from "react";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db, schema } from "@/db";
import type { Teacher } from "@/db/schema";

// Server-only: returns the teachers row for the signed-in Clerk user,
// creating it on first visit and syncing name and email from Clerk.
// Cached per request so the layout, page, and actions share one upsert.
export const getOrCreateTeacher = cache(async (): Promise<Teacher> => {
  const user = await currentUser();
  if (!user) {
    const { redirectToSignIn } = await auth();
    return redirectToSignIn();
  }

  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress;
  if (!email) {
    throw new Error(`Clerk user ${user.id} has no email address`);
  }
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.username ||
    null;

  const [teacher] = await db
    .insert(schema.teachers)
    .values({ clerkUserId: user.id, name, email })
    .onConflictDoUpdate({
      target: schema.teachers.clerkUserId,
      set: { name, email },
    })
    .returning();
  return teacher;
});
