import { UserButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";

export default async function TeacherDashboard() {
  const user = await currentUser();
  const displayName =
    user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? "teacher";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-16">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Teacher dashboard</h1>
        <UserButton />
      </header>
      <p>Signed in as {displayName}.</p>
      <p className="text-zinc-600 dark:text-zinc-400">
        Classes, readings, and the challenge queue will live here.
      </p>
    </main>
  );
}
