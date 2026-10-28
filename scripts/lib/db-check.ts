// Shared setup for every scripts/check-*.ts: the guard that keeps them off
// any real database, and the cap on concurrent database work.
//
// Guard (dbCheckRefusal): the checks write and delete rows, so they refuse
// to run, before any query, unless
// - DATABASE_URL points at a local or test database: the host is
//   localhost, 127.0.0.1, ::1, or *.localtest.me (the local Neon proxy),
//   or the database name contains "test" (a Neon branch made for the
//   checks, say unpack_test); and
// - ALLOW_DB_WRITES=1.
// The message never includes the URL, its host, or any other env value.
//
// Connection cap (limitConcurrency, installed by prepareDbCheck): every
// HTTP query the Neon driver sends in this process goes through one small
// semaphore, so a burst of Promise.all work can't open more Postgres
// connections than DB_CHECK_CONCURRENCY at once (a local Postgres with
// max_connections=100 behind the proxy failed with 53300 "too many
// clients" before). Each request is a whole non-interactive transaction
// (its locks end with it), so queueing requests can't deadlock: no request
// waits for another while holding a connection. The cap holds a slot until
// the response body is read, so a slot is never freed while the proxy is
// still answering.

import { neonConfig } from "@neondatabase/serverless";
import type { StatementExecutor } from "@/lib/link-rate-limit";

export const LOCAL_DB_HOSTS = ["localhost", "127.0.0.1", "::1"];
export const LOCAL_DB_HOST_SUFFIX = ".localtest.me";

// Small on purpose: enough parallel requests to race the locks, far under
// any max_connections.
export const DEFAULT_DB_CHECK_CONCURRENCY = 8;

type Env = Partial<Record<string, string | undefined>>;

export function isLocalOrTestDatabase(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_DB_HOSTS.includes(host)) return true;
  if (host === LOCAL_DB_HOST_SUFFIX.slice(1) || host.endsWith(LOCAL_DB_HOST_SUFFIX)) return true;
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
  return name.toLowerCase().includes("test");
}

// Why the checks must not run, or null when they may.
export function dbCheckRefusal(env: Env): string | null {
  const url = env.DATABASE_URL;
  if (!url) return "DATABASE_URL is not set. Refusing to run.";
  if (!isLocalOrTestDatabase(url)) {
    return (
      "Refusing to run: this script writes and deletes rows, so DATABASE_URL must point at a " +
      `local or test database (host ${LOCAL_DB_HOSTS.join(", ")}, or *${LOCAL_DB_HOST_SUFFIX}; ` +
      'or a database name containing "test"). Never use production.'
    );
  }
  if (env.ALLOW_DB_WRITES !== "1") return "This script writes and deletes rows. Set ALLOW_DB_WRITES=1 to run it.";
  return null;
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

// p-limit style: at most `max` tasks run at once; the rest wait their turn
// in order.
export function limitConcurrency(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error("max must be a positive integer");
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

// An executor with at most `max` batches in flight (on top of the global
// fetch cap), for a script that wants a smaller burst.
export function throttledExecutor(execute: StatementExecutor, max: number): StatementExecutor {
  const limit = limitConcurrency(max);
  return (statements) => limit(() => execute(statements));
}

// A fetch that holds a slot until the whole body is read.
export function limitedFetch(limit: Limiter, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) =>
    limit(async () => {
      const response = await base(input, init);
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
}

export function dbCheckConcurrency(env: Env): number {
  const value = Number(env.DB_CHECK_CONCURRENCY);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DB_CHECK_CONCURRENCY;
}

export type DbCheckSetup = { fetchEndpoint: string | undefined; concurrency: number };

// Call first, at the top of every check script, before any query: exits
// with code 2 when the guard refuses. Then it removes the AI credentials
// (every check injects a fake model; this makes sure nothing could reach a
// real one), points the driver at NEON_FETCH_ENDPOINT if set, and installs
// the connection cap.
export function prepareDbCheck(env: Env = process.env): DbCheckSetup {
  const refusal = dbCheckRefusal(env);
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
  for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "ANTHROPIC_API_KEY"]) delete env[name];
  const fetchEndpoint = env.NEON_FETCH_ENDPOINT;
  if (fetchEndpoint) neonConfig.fetchEndpoint = () => fetchEndpoint;
  const concurrency = dbCheckConcurrency(env);
  neonConfig.fetchFunction = limitedFetch(limitConcurrency(concurrency));
  return { fetchEndpoint, concurrency };
}
