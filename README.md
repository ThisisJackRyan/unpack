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

Copy `.env.example` to `.env.local` and fill it in. Sign-in and sign-up are in-app pages (`/sign-in` and `/sign-up`, Clerk's `<SignIn />` and `<SignUp />` on our own routes, public in `src/proxy.ts`), not Clerk's hosted pages: the landing page's "Get started" opens `/sign-up` and "Sign in" opens `/sign-in`. Keep `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in` and `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up` as in `.env.example` (the code passes the same paths, so a deploy without them still works; no Clerk dashboard change is needed). Both land on `/home`, which sends each account to its home (`/welcome` for a new account); keep `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` at `/home` if set. Apply migration `drizzle/0009_hardening.sql` (`pnpm db:migrate`) before running this version. Question writing and the effort check call Claude through Vercel AI Gateway. On Vercel, enable AI Gateway for the project and it authenticates with the deployment's OIDC token: no env needed. Locally, run `vercel link` and `vercel env pull` (writes the project's Development env vars, `VERCEL_OIDC_TOKEN` included, to `.env.local`; it expires after 12 hours, so pull again, or use `vercel dev`, which refreshes it), or set `AI_GATEWAY_API_KEY` to an AI Gateway API key. A key, if set, always wins over OIDC. With neither, teachers see "Question writing isn’t set up yet." and the server logs what's missing. `AI_MODEL` is optional and defaults to `anthropic/claude-sonnet-5.5`; the old `ANTHROPIC_MODEL` is still read (a bare id like `claude-sonnet-5-5` becomes `anthropic/claude-sonnet-5.5`), and `ANTHROPIC_API_KEY` is no longer used. The request (low effort, strict tools, auto tool choice) targets current 5.x models; an older model may return a 400.

The student join form's bot check (Cloudflare Turnstile) is on when both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. In production both are required: with either missing, every join is refused and the server logs which one (set `TURNSTILE_DISABLED=1` to opt out on purpose; it logs a warning on every join). For local dev leave both empty (off), or use Cloudflare's public test keys (see `.env.example`). On Vercel Preview the hostname check uses the branch and deployment URLs (`VERCEL_BRANCH_URL`, `VERCEL_URL`); if previews are served on a custom domain, set `TURNSTILE_EXPECTED_HOSTNAMES` for the Preview environment. `TURNSTILE_DISABLED=1` is an emergency switch only; remove it once the problem is fixed. Teacher sign-up's bot check is Clerk's own "Challenge suspicious sign-ups" (Clerk Dashboard, Protect, Protections), on by default for new Clerk apps; see the v1 spec for exactly what it covers.

### Clerk webhook

`/api/webhooks/clerk` keeps the `teachers` row (every account, teacher or self-learner) in step with Clerk: `user.created` saves the account's name and primary email (never a role), `user.updated` updates them on an existing account (never creating one, so a late event can't bring back a deleted account), and `user.deleted` deletes the account and everything under it (classes, readings, students, and their work, and self-learner readings with their questions, tries, answers, and effort checks) in one transaction. To set it up for each Clerk instance (development and production are separate):

1. Clerk Dashboard, **Configure**, **Webhooks**, **Add endpoint**.
2. Endpoint URL: `https://<your domain>/api/webhooks/clerk`.
3. Subscribe to `user.created`, `user.updated`, and `user.deleted`.
4. Create it, copy its **Signing Secret** (`whsec_...`), and set it as `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel (and `.env.local` if you test it locally through a tunnel).

The route is public (no Clerk session); every delivery's signature is checked. A missing or bad signature gets a 400; a missing secret gets a 500 and a server log. Logs name only the event type and outcome. Teachers are still created on their first visit if the webhook isn't set up.

### Database checks

`pnpm db:check-*` scripts (class limit, student questions, student join, student answers, teacher queue, abuse protection, teacher gaps, self-learner, limiter concurrency) run race checks against a local or test database with a mock model. They write and delete rows, so every one refuses to run, before any query, unless `ALLOW_DB_WRITES=1` is set for that one command and `DATABASE_URL` points at a local or test database: the host is `localhost`, `127.0.0.1`, `::1`, or `*.localtest.me` (the local Neon proxy), or the database name contains `test` (for a Neon branch made for the checks, say `unpack_test`). For example `ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-abuse-protection`. Don't export it in your shell, and never point them at production. Each script keeps at most `DB_CHECK_CONCURRENCY` (default 8) queries in flight, so a full run stays far under Postgres's `max_connections` (the shared setup is `scripts/lib/db-check.ts`).

## Deploy (Vercel)

1. **Enable AI Gateway on the Vercel project** (Vercel dashboard, the project, AI Gateway) before the first deploy. Deployments authenticate to the gateway with the project's OIDC token, but OIDC alone, without the gateway enabled for the project, gets 401s: every question write and effort check then fails as "Question writing isn’t set up yet." (and checks are given back). No `AI_GATEWAY_API_KEY` is needed on Vercel. Calls are pinned to Anthropic as the only provider. If the gateway runs out of credits, the server logs "AI Gateway is out of credits (402)" and failed calls are given back.
2. Set the env vars from `.env.example` for Production and Preview: the Clerk keys, `DATABASE_URL`, `JOIN_IP_HASH_SECRET` (required in production), both Turnstile keys (required in production), and `CLERK_WEBHOOK_SIGNING_SECRET`.
3. Apply the migrations (`pnpm db:migrate`, through `drizzle/0009_hardening.sql`) to the production database.
4. Set up the Clerk webhook (below) for the production Clerk instance.
