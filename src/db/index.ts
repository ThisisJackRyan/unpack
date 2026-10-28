import { neon, neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { readTimeoutFetchFunction } from "./read-timeout";
import * as schema from "./schema";

export type Database = NeonHttpDatabase<typeof schema>;

let client: NeonQueryFunction<false, false> | undefined;
let instance: Database | undefined;

// Raw Neon http client, for the rare query drizzle can't express (such as
// a locking multi-statement transaction). Created on first
// use so importing this module never requires DATABASE_URL (for example
// during `next build`). Its requests go through the read timeout
// (read-timeout.ts: reads give up after DB_READ_TIMEOUT_MS, writes are
// never cut), wrapped around whatever fetch is set by then: the global
// fetch, or a check script's own (scripts/lib/db-check.ts sets its
// connection cap and NEON_FETCH_ENDPOINT before the first query).
export function getSql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
    neonConfig.fetchFunction = readTimeoutFetchFunction(neonConfig.fetchFunction);
    client = neon(url);
  }
  return client;
}

export function getDb(): Database {
  if (!instance) {
    instance = drizzle(getSql(), { schema });
  }
  return instance;
}

// Lazy handle with the same API as the drizzle client: `db.select()...`.
export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const client = getDb();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export { schema };
