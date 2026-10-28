"use server";

import { notFound, redirect, RedirectType, unstable_rethrow } from "next/navigation";
import type { ReadingFormState } from "@/components/reading-form-state";
import { guardCreate, readingSaveFailedState } from "@/lib/create-guard";
import { qaRoutesEnabled } from "@/lib/qa-routes";
import { createSelfReadingWith } from "@/lib/self-reading-create";
import { readingFormInput, readingFormValues } from "@/lib/validate-reading";

export type QaCreateOptions = {
  // deadline: the account lookup takes 5s, past `precheckMs`. throw: the
  // account lookup throws. ok: the create works and redirects.
  mode: "deadline" | "throw" | "ok";
  // The pre-write deadline, in place of PRE_WRITE_DEADLINE_MS.
  precheckMs: number;
  // The ?run= id, for the server log marker.
  run: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The QA new-reading form's action: no database, no Clerk, no fetch. The
// real createSelfReadingWith inside the real guardCreate, as
// /learn/new's action runs them, over fake dependencies. 404 unless
// UNPACK_QA_ROUTES=1.
export async function qaCreateAction(options: QaCreateOptions, _prev: ReadingFormState, formData: FormData): Promise<ReadingFormState> {
  if (!qaRoutesEnabled()) notFound();
  // When the request reached the server. The QA run id only.
  console.log(`qa-create-action started run=${String(options.run).slice(0, 40)}`);
  const input = readingFormInput(formData);
  const result = await guardCreate(
    (preWrite) =>
      createSelfReadingWith(input, preWrite, {
        requireAccount: async () => {
          if (options.mode === "throw") throw new Error("QA account lookup failed");
          if (options.mode === "deadline") await sleep(5_000);
          return { id: "qa-account" };
        },
        getAllowance: async () => ({ remaining: 5 }),
        recordLinkFetch: async () => true,
        linkLimitedMessage: async () => "",
        fetchArticle: async () => {
          throw new Error("QA: no link fetches");
        },
        createSelfReading: async () => ({ status: "created", id: "qa-reading" }),
        log: () => {},
      }),
    () => ({ state: readingSaveFailedState(readingFormValues(input)) }),
    {
      rethrow: unstable_rethrow,
      onError: (error) => console.error("qa-create-action failed", (error as { name?: unknown }).name),
      deadlineMs: Math.min(Math.max(Number(options.precheckMs) || 0, 0), 30_000),
    },
  );
  if ("state" in result) return result.state;
  redirect("/qa/create-guard/landed", RedirectType.replace);
}
