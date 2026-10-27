// Recomputes students.name_key with the current studentNameKey (see
// src/lib/student-name.ts). Run it after any change to the name folding,
// or two look-alike names could both join a class (old rows keep their old
// keys; new joins use the new ones).
//
//   DATABASE_URL=... pnpm db:recompute-name-keys            (dry run)
//   ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:recompute-name-keys
//
// Dry run by default: it only counts. With ALLOW_DB_WRITES=1 it updates
// every changed key, in ONE transaction (two steps: changed rows get a
// temporary unique key first, so swapping keys within a class can't trip
// the unique (class_id, name_key) constraint mid-way).
//
// Collisions: students in one class whose new keys are equal (say
// "Keʻala Pa" and "Keala Pa", which used to be distinct) can't both have
// it. They are reported as counts and left unchanged, never merged or
// renamed: progress is tied to the session, so the teacher decides (the
// students still work; only a new join with that name is affected).
//
// It prints counts only, never names, ids, or keys. A join that lands
// while it runs can make the write fail on the unique constraint; nothing
// is saved then, so run it again.
import { neonConfig } from "@neondatabase/serverless";
import { getSql } from "@/db";
import { studentNameKey } from "@/lib/student-name";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Refusing to run.");
  process.exit(2);
}
const write = process.env.ALLOW_DB_WRITES === "1";
const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
if (fetchEndpoint) {
  neonConfig.fetchEndpoint = () => fetchEndpoint;
}

type Row = { id: string; class_id: string; first_name: string; last_initials: string; name_key: string };

async function main(): Promise<void> {
  const sql = getSql();
  const rows = (await sql`
    select id, class_id, first_name, last_initials, name_key from students`) as Row[];

  // Group by class and new key; a group of 2 or more is a collision.
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.class_id}\u0000${studentNameKey(row.first_name, row.last_initials)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const collided = [...groups.values()].filter((g) => g.length > 1);
  const collidedIds = new Set(collided.flat().map((r) => r.id));
  const classesWithCollisions = new Set(collided.map((g) => g[0].class_id));
  const changes = rows
    .filter((r) => !collidedIds.has(r.id))
    .map((r) => ({ id: r.id, key: studentNameKey(r.first_name, r.last_initials), old: r.name_key }))
    .filter((c) => c.key !== c.old);

  console.log(`students: ${rows.length}`);
  console.log(`keys to change: ${changes.length}`);
  console.log(
    `collisions: ${collided.length} (${collidedIds.size} students in ${classesWithCollisions.size} classes), left unchanged`,
  );

  if (!write) {
    console.log("\nDry run: nothing written. Set ALLOW_DB_WRITES=1 to write the changed keys.");
    return;
  }
  if (changes.length === 0) {
    console.log("\nNothing to write.");
    return;
  }
  const ids = changes.map((c) => c.id);
  const keys = changes.map((c) => c.key);
  const olds = changes.map((c) => c.old);
  // Each step only touches a row whose key is still the one read above,
  // so a row changed meanwhile is skipped, not overwritten.
  const [temp, final] = await sql.transaction(
    [
      sql.query(
        `update students s set name_key = 'recompute:' || s.id::text
from unnest($1::uuid[], $2::text[]) as c(id, old)
where s.id = c.id and s.name_key = c.old
returning s.id`,
        [ids, olds],
      ),
      sql.query(
        `update students s set name_key = c.key
from unnest($1::uuid[], $2::text[]) as c(id, key)
where s.id = c.id and s.name_key = 'recompute:' || s.id::text
returning s.id`,
        [ids, keys],
      ),
    ],
    { isolationLevel: "ReadCommitted" },
  );
  console.log(`\nwrote ${(final as unknown[]).length} keys (${(temp as unknown[]).length} matched)`);
}

main().catch((error) => {
  // Name, code, and message only: a constraint error's detail can echo a
  // row.
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  console.error("recompute-name-keys failed:", { name, code, message });
  process.exit(1);
});
