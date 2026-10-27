import type { Metadata } from "next";
import Link from "next/link";
import { backLink, card } from "@/components/ui";
import { loadChallengeQueue } from "@/lib/challenge-queue";
import { getOrCreateTeacher } from "@/lib/teacher";
import { loadClass } from "../loaders";
import { decideChallengeAction } from "./actions";
import { ChallengeQueue } from "./queue";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const found = await loadClass(id);
  return { title: `Challenges: ${found.name}` };
}

// The open challenges in this class, oldest first: who, which reading,
// their note, and their last try answer by answer, then Accept or Deny.
// Only the owning teacher gets here (loadClass 404s others), and each
// decision checks ownership again in its own transaction.
export default async function ChallengesPage({ params }: Props) {
  const { id } = await params;
  const found = await loadClass(id);
  const teacher = await getOrCreateTeacher();
  const items = await loadChallengeQueue(found.id, teacher.id);

  return (
    <div className="flex flex-col gap-8">
      <Link href={`/teacher/classes/${found.id}`} className={`${backLink} self-start`}>
        <span aria-hidden="true">←</span> <span className="break-words">Back to {found.name}</span>
      </Link>

      <div className="flex flex-col gap-1">
        <h1 id="queue-heading" tabIndex={-1} className="text-3xl font-semibold tracking-tight text-zinc-950 focus:outline-none">
          Challenges
        </h1>
        <p className="text-lg text-zinc-600">
          Students who think they did their best can ask you to look. Accept counts the reading as passed.
        </p>
      </div>

      <ChallengeQueue action={decideChallengeAction.bind(null, found.id)} items={items} />

      {items.length === 0 && (
        <p className={`${card} px-6 py-12 text-center text-lg text-zinc-600`}>
          You’re all caught up. New challenges show up here.
        </p>
      )}
    </div>
  );
}
