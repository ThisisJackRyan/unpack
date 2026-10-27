import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Database = NeonHttpDatabase<typeof schema>;

let client: NeonQueryFunction<false, false> | undefined;
let instance: Database | undefined;

// Raw Neon http client, for the rare query drizzle can't express (such as
// a locking multi-statement transaction). Created on first
// use so importing this module never requires DATABASE_URL (for example
// during `next build`).
export function getSql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set");
    }
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
