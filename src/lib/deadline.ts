// A bound on waiting for work that can't be stopped (see
// answer-check-guard.ts for where it's used).

export class DeadlineError extends Error {
  constructor() {
    super("pre-check deadline passed");
    this.name = "DeadlineError";
  }
}

// `work`, unless `signal` aborts first: then a DeadlineError. The work
// isn't stopped (a database call can't be), only no longer waited on, so
// use this for reads. A rejection from the work (a redirect, say) comes
// through as is.
export function withDeadline<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
