# unpack

A reading check that's hard to fake: students read a text, then answer AI-generated questions about it, and they move on only when they've genuinely tried.

## Core loop

1. A teacher picks a reading (link or pasted text) and shares a class code.
2. A student joins with the code and reads the text in unpack.
3. AI generates a few open-ended questions tied to specific details in the passage, plus one asking for the student's own take.
4. The student answers. AI grades pass/fail on **effort only** (did they try and engage with the text), not quality.
5. On a fail, the student gets a specific nudge and revises, up to 3 tries. On a pass, they move on.
6. After 3 fails, the student can send a challenge that the teacher reviews and resolves.

Self-learners (13+) can also sign in and use the same loop on their own readings, 5 new ones per rolling 7 days, with no class and no challenge: after 3 failed tries they see the nudges and move on.

## Stack (locked)

- [Next.js 16](https://nextjs.org) on [Vercel](https://vercel.com)
- [Neon](https://neon.tech) Postgres
- [Clerk](https://clerk.com) auth for **teachers and self-learners** (a new account chooses its role on `/welcome`). Students have no accounts: they join with a class code, their first name, and the first 1-2 letters of their last name.
- [Claude](https://www.anthropic.com/claude) through [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) (with the [AI SDK](https://ai-sdk.dev)) for question generation and the effort check

## Docs

- [Product brief](docs/product-brief.md)
- [v1 features and data model](docs/v1-spec.md)
- [Student data and privacy](docs/privacy.md)

## Local development

Requires Node.js and [pnpm](https://pnpm.io).

```bash
pnpm install   # install dependencies
pnpm dev       # start the dev server at http://localhost:3000
pnpm lint      # run ESLint
pnpm build     # production build
pnpm test      # unit tests (no network; the model and the gateway are faked)
```

Copy `.env.example` to `.env.local` and fill it in. Sign-in and sign-up are in-app pages (`/sign-in` and `/sign-up`, Clerk's `<SignIn />` and `<SignUp />` on our own routes, public in `src/proxy.ts`), not Clerk's hosted pages: the landing page's "Get started" opens `/sign-up` and "Sign in" opens `/sign-in`. Keep `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up` as in `.env.example` (the code passes the same paths, so a deploy without them still works; no Clerk dashboard change is needed). Both land on `/home`, which sends each account to its home (`/welcome` for a new account); keep `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` at `/home` if set. Signing out lands on the landing page `/` (`afterSignOutUrl` on `ClerkProvider`; no env var needed). Apply `drizzle/0009_hardening.sql` before running this version, by hand (see Migrations below). Question writing and the effort check call Claude through Vercel AI Gateway. On Vercel, enable AI Gateway for the project and it authenticates with the deployment's OIDC token: no env needed. Locally, run `vercel link` and `vercel env pull` (writes the project's Development env vars, `VERCEL_OIDC_TOKEN` included, to `.env.local`; it expires after 12 hours, so pull again, or use `vercel dev`, which refreshes it), or set `AI_GATEWAY_API_KEY` to an AI Gateway API key. A key, if set, always wins over OIDC. With neither, question writing shows as unavailable (teachers see "Question writing isn’t available right now. Trying again soon won’t help, so please check back later.", students and self-learners a come-back-later note with no Try again) and the server logs what's missing. `AI_MODEL` is optional and defaults to `anthropic/claude-sonnet-5.5`; the old `ANTHROPIC_MODEL` is still read (a bare id like `claude-sonnet-5-5` becomes `anthropic/claude-sonnet-5.5`), and `ANTHROPIC_API_KEY` is no longer used. The request (low effort, strict tools, auto tool choice) targets current 5.x models; an older model may return a 400.

The student join form's bot check (Cloudflare Turnstile) is on when both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. In production both are required: with either missing, every join is refused and the server logs which one (see below) (set `TURNSTILE_DISABLED=1` to opt out on purpose; it logs a warning on every join). For local dev leave both empty (off), or use Cloudflare's public test keys (see `.env.example`). On Vercel Preview the hostname check uses the branch and deployment URLs (`VERCEL_BRANCH_URL`, `VERCEL_URL`); if previews are served on a custom domain, set `TURNSTILE_EXPECTED_HOSTNAMES` for the Preview environment. `TURNSTILE_DISABLED=1` is an emergency switch only; remove it once the problem is fixed. If students see "Joining isn’t working right now. Please try again in a little while.", check the Vercel runtime logs for `join_blocked_config`: each refused join logs the missing variable name(s) (never a value). Set the Turnstile keys (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, or `TURNSTILE_DISABLED=1` to opt out on purpose) or `JOIN_IP_HASH_SECRET` (at least 32 characters, `openssl rand -base64 32`) for Production and redeploy. Teacher sign-up's bot check is Clerk's own "Challenge suspicious sign-ups" (Clerk Dashboard, Protect, Protections), on by default for new Clerk apps; see the v1 spec for exactly what it covers.

### Clerk webhook

`/api/webhooks/clerk` keeps the `teachers` row (every account, teacher or self-learner) in step with Clerk: `user.created` saves the account's name and primary email (never a role), `user.updated` updates them on an existing account (never creating one, so a late event can't bring back a deleted account), and `user.deleted` deletes the account and everything under it (classes, readings, students, and their work, and self-learner readings with their questions, tries, answers, and effort checks) in one transaction. To set it up for each Clerk instance (development and production are separate):

1. Clerk Dashboard, **Configure**, **Webhooks**, **Add endpoint**.
2. Endpoint URL: `https://<your domain>/api/webhooks/clerk`.
3. Subscribe to `user.created`, `user.updated`, and `user.deleted`.
4. Create it, copy its **Signing Secret** (`whsec_...`), and set it as `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel (and `.env.local` if you test it locally through a tunnel).

The route is public (no Clerk session); every delivery's signature is checked. A missing or bad signature gets a 400; a missing secret gets a 500 and a server log. Logs name only the event type and outcome. Teachers are still created on their first visit if the webhook isn't set up.

### Database checks

`pnpm db:check-*` scripts (class limit, student questions, student join, student answers, teacher queue, abuse protection, teacher gaps, self-learner, limiter concurrency) run race checks against a local or test database with a mock model. They write and delete rows, so every one refuses to run, before any query, unless `ALLOW_DB_WRITES=1` is set for that one command and `DATABASE_URL` points at a local or test database: the host is `localhost`, `127.0.0.1`, `::1`, or `*.localtest.me` (the local Neon proxy), or the database name contains `test` (for a Neon branch made for the checks, say `unpack_test`). For example `ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-abuse-protection`. Don't export it in your shell, and never point them at production. Each script keeps at most `DB_CHECK_CONCURRENCY` (default 8) queries in flight, so a full run stays far under Postgres's `max_connections` (the shared setup is `scripts/lib/db-check.ts`).

### Migrations

Apply migrations by hand, in order, one `drizzle/*.sql` file at a time, each as one transaction. Don't use `pnpm db:migrate`: the Neon database has no drizzle migrations table, so it would replay from `0000`, and port 5432 is blocked anyway.

- Neon SQL Editor: paste the whole file between `BEGIN;` and `COMMIT;`.
- Neon HTTP driver (`@neondatabase/serverless`): each request is its own transaction, so sending `BEGIN;` and `COMMIT;` as separate requests does nothing. Split the file on `--> statement-breakpoint` and send its statements together with `sql.transaction(statements.map((s) => sql.query(s)))`.

Either way, a file that fails rolls back as a whole.

The files are not idempotent and nothing records which ones were applied. Run these read-only checks, then apply in order starting from the first file whose check returns false. `col(t, c)` stands for `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '<t>' and column_name = '<c>');`.

| File | Check |
| --- | --- |
| `0000_init` | `select to_regclass('public.teachers') is not null;` |
| `0001_link_fetch_attempts` | `select to_regclass('public.link_fetch_attempts') is not null;` |
| `0002_question_generation` | `select to_regclass('public.question_generations') is not null;` |
| `0003_join_attempts` | `select to_regclass('public.join_attempts') is not null;` |
| `0004_effort_checks` | `select to_regclass('public.effort_checks') is not null;` |
| `0005_teacher_queue` | `col(challenges, checks_allowed)` |
| `0006_abuse_protection` | `select to_regclass('public.student_question_calls') is not null;` |
| `0007_teacher_gaps` | `col(student_question_calls, given_back)` |
| `0008_self_learner` | `col(teachers, age_confirmed_at)` |
| `0009_hardening` | `col(deleted_clerk_users, clerk_deleted_at)` and `col(self_readings, slot_released_at)` |

`0009_hardening.sql` was edited in place (PR 16). A database that got the earlier hand-applied 0009 has `slot_released_at` but not `clerk_deleted_at` (and has the index `deleted_clerk_users_deleted_at_idx`). Running the current file there fails at `CREATE TABLE` and rolls back, and the missing column breaks the under-13 delete. For that case, run this in the SQL Editor instead of the file:

```sql
BEGIN;
ALTER TABLE deleted_clerk_users ADD COLUMN clerk_deleted_at timestamptz;
CREATE INDEX deleted_clerk_users_clerk_deleted_at_idx ON deleted_clerk_users (clerk_deleted_at);
DROP INDEX IF EXISTS deleted_clerk_users_deleted_at_idx;
COMMIT;
```

The edited 0009 is already applied to Neon main and dev (Oct 27, 2026).

### Ops: pending Clerk deletes

`DATABASE_URL=... pnpm ops:list-pending-clerk-deletes` (read-only) lists under-13 deletes (or role-less sweep deletes, below) whose Clerk delete failed and is still pending (the Clerk account may still exist; the row is never pruned until Clerk confirms): the count, a hash prefix and age per row. Add `--match-clerk` with `CLERK_SECRET_KEY` set to page through Clerk's users and print only the matching Clerk ids; delete each in the Clerk dashboard, and the `user.deleted` webhook confirms the row. See `scripts/list-pending-clerk-deletes.ts`.

### Ops: sweep role-less Clerk accounts

Someone who signs in but never picks a role on `/welcome` leaves a Clerk account (with its email), and often a `teachers` row with no role (name and email). `pnpm ops:sweep-roleless-clerk-users` (needs `DATABASE_URL` and `CLERK_SECRET_KEY`) deletes the ones older than a threshold, without warning the account holder (`docs/privacy.md` says so). Always dry run first:

1. `DATABASE_URL=... CLERK_SECRET_KEY=... pnpm ops:sweep-roleless-clerk-users --expect-db=<host>/<dbname> --expect-instance=<ins_id>` (dry run, the default): first the environment guard below, then it pages through Clerk's users (reads only id, created_at, last_sign_in_at and last_active_at), keeps those created and last used at least 7 days ago (last used: the latest of the three times; a missing or unreadable time counts as recent, so that account is left alone) with no teacher or self-learner role (no row at all, a row with no role, or a pending delete; a confirmed delete is skipped; a teacher or self-learner account is never swept, however old), and prints the count and, per account, the Clerk id, a 12-character hash prefix, which kind, and how many days ago it was last used. Last, it prints the exact `--apply` command to copy, with `--expect-count`, the expect flags, `--min-age-days` and `--limit`. Writes nothing and deletes nothing.
2. Check the list, then run that printed command, with the same `DATABASE_URL` and `CLERK_SECRET_KEY`: oldest first, up to the limit. Each account is re-checked and our side deleted in one transaction (the under-13 delete's statements: a role saved since the dry run is skipped, the row with no role is deleted, the id's hash is listed as pending), then deleted in Clerk, then the hash is confirmed (pruned 30 days later, like any deleted account). The first Clerk error stops the run and prints only the HTTP status; that hash stays pending, so `pnpm ops:list-pending-clerk-deletes` shows it.

Guards. Each one refuses with a `Refused: ...` line and exit code 1 before anything changes:

- **Environment**, before any Clerk user is listed or any row looked up. The run first prints the Clerk instance id and environment type (from Clerk's `GET /v1/instance`), the key type (`sk_live` or `sk_test`, from the key's prefix), and the database host and name from `DATABASE_URL` (never the user, password, or key). Then:
  - Live/test pairing: a `sk_test` key needs a development instance and a local or test database (the db checks' rule: localhost, `*.localtest.me`, or a database name containing "test"); a `sk_live` key needs a non-development instance and any other database. Anything else is refused.
  - `--expect-db=<host>/<dbname>` (required) must match the host and database name in `DATABASE_URL`.
  - `--expect-instance=<ins_id>` (required) must match the instance the key belongs to.
  Write both from what you know the target is (the Neon console for the database; the Clerk instance you mean to sweep). A refused run prints what it found, so you can see which side is wrong; don't copy those values back without checking them.
- **Shape**, after the read-only lookup. On the right pair almost every aged Clerk user has a `teachers` row; on the wrong database almost none does, and every Clerk user would look role-less. So the run aborts if there is at least one aged user and none of them has a `teachers` row, or if at least 10 users are aged (`NO_ROW_SHARE_MIN_AGED`) and more than 50% of them (`NO_ROW_SHARE_MAX`) have no `teachers` row. There is no override flag: if a real run hits this, look at the data first.
- **Count**, with `--apply`. `--expect-count=N` is required and must equal the number of candidates this run finds (the dry run's count). If anything changed since the dry run, the run aborts; dry run again and check the new list.

Flags: `--expect-db=<host>/<dbname>` and `--expect-instance=<ins_id>` (always required); `--apply` with `--expect-count=N` (each needs the other); `--min-age-days=N` (days since created and last used, default 7, never under 7); `--limit=N` (Clerk deletes per run, default 25, at most 500). Anything else is refused. `ALLOW_DB_WRITES=1 DATABASE_URL=<local or test> pnpm db:check-roleless-clerk-sweep` checks it against a test database with a fake Clerk, guards included. See `scripts/sweep-roleless-clerk-users.ts`.

## Deploy (Vercel)

1. **Enable AI Gateway on the Vercel project** (Vercel dashboard, the project, AI Gateway) before the first deploy. Deployments authenticate to the gateway with the project's OIDC token, but OIDC alone, without the gateway enabled for the project, gets 401s: every question write and effort check then fails as unavailable ("Question writing isn’t available right now.") (and checks are given back). No `AI_GATEWAY_API_KEY` is needed on Vercel. Calls are pinned to Anthropic as the only provider. If the gateway runs out of credits, the server logs "AI Gateway is out of credits (402)" and failed calls are given back.
2. Set the env vars from `.env.example` for Production and Preview: the Clerk keys, `DATABASE_URL`, `JOIN_IP_HASH_SECRET` (required in production), both Turnstile keys (required in production), and `CLERK_WEBHOOK_SIGNING_SECRET`.
3. Apply any new migrations, through `drizzle/0009_hardening.sql`, to the production database by hand (see Migrations below).
4. Set up the Clerk webhook (below) for the production Clerk instance.
