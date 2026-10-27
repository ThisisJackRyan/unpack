import { cache } from "react";
import { eq } from "drizzle-orm";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db, schema } from "@/db";
import type { Teacher } from "@/db/schema";

// Server-only: returns the teachers row for the signed-in Clerk user,
// creating it on first visit with name and email from Clerk. Cached per
// request so the layout, page, and actions share one lookup. Only a first
// visit calls the Clerk API (currentUser); later visits just read the row.
export const getOrCreateTeacher = cache(async (): Promise<Teacher> => {
  const { userId, redirectToSignIn } = await auth();
  if (!userId) {
    return redirectToSignIn();
  }

  const [existing] = await db
    .select()
    .from(schema.teachers)
    .where(eq(schema.teachers.clerkUserId, userId))
    .limit(1);
  if (existing) return existing;

  const user = await currentUser();
  if (!user) {
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

  // Upsert, not insert: two first-visit requests can race to create the row.
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
