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

Copy `.env.example` to `.env.local` and fill it in. Sign-in and sign-up land on `/home`, which sends each account to its home; `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` and `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` are optional (keep them `/home` if set). Apply migration `drizzle/0008_self_learner.sql` (`pnpm db:migrate`) before running this version. Question writing and the effort check call Claude through Vercel AI Gateway. On Vercel, enable AI Gateway for the project and it authenticates with the deployment's OIDC token: no env needed. Locally, run `vercel link` and `vercel env pull` (writes the project's Development env vars, `VERCEL_OIDC_TOKEN` included, to `.env.local`; it expires after 12 hours, so pull again, or use `vercel dev`, which refreshes it), or set `AI_GATEWAY_API_KEY` to an AI Gateway API key. A key, if set, always wins over OIDC. With neither, teachers see "Question writing isn’t set up yet." and the server logs what's missing. `AI_MODEL` is optional and defaults to `anthropic/claude-sonnet-5.5`; the old `ANTHROPIC_MODEL` is still read (a bare id like `claude-sonnet-5-5` becomes `anthropic/claude-sonnet-5.5`), and `ANTHROPIC_API_KEY` is no longer used. The request (low effort, strict tools, auto tool choice) targets current 5.x models; an older model may return a 400.

The student join form's bot check (Cloudflare Turnstile) is on when both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. In production both are required: with either missing, every join is refused and the server logs which one (see below) (set `TURNSTILE_DISABLED=1` to opt out on purpose; it logs a warning on every join). For local dev leave both empty (off), or use Cloudflare's public test keys (see `.env.example`). On Vercel Preview the hostname check uses the branch and deployment URLs (`VERCEL_BRANCH_URL`, `VERCEL_URL`); if previews are served on a custom domain, set `TURNSTILE_EXPECTED_HOSTNAMES` for the Preview environment. `TURNSTILE_DISABLED=1` is an emergency switch only; remove it once the problem is fixed. If students see "Joining is turned off right now. Ask your teacher.", check the Vercel runtime logs for `join_blocked_config`: each refused join logs the missing variable name(s) (never a value). Set the Turnstile keys (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, or `TURNSTILE_DISABLED=1` to opt out on purpose) or `JOIN_IP_HASH_SECRET` (at least 32 characters, `openssl rand -base64 32`) for Production and redeploy. Teacher sign-up's bot check is Clerk's own "Challenge suspicious sign-ups" (Clerk Dashboard, Protect, Protections), on by default for new Clerk apps; see the v1 spec for exactly what it covers.

### Clerk webhook

`/api/webhooks/clerk` keeps the `teachers` row (every account, teacher or self-learner) in step with Clerk: `user.created` saves the account's name and primary email (never a role), `user.updated` updates them on an existing account (never creating one, so a late event can't bring back a deleted account), and `user.deleted` deletes the account and everything under it (classes, readings, students, and their work, and self-learner readings with their questions, tries, answers, and effort checks) in one transaction. To set it up for each Clerk instance (development and production are separate):

1. Clerk Dashboard, **Configure**, **Webhooks**, **Add endpoint**.
2. Endpoint URL: `https://<your domain>/api/webhooks/clerk`.
3. Subscribe to `user.created`, `user.updated`, and `user.deleted`.
4. Create it, copy its **Signing Secret** (`whsec_...`), and set it as `CLERK_WEBHOOK_SIGNING_SECRET` in Vercel (and `.env.local` if you test it locally through a tunnel).

The route is public (no Clerk session); every delivery's signature is checked. A missing or bad signature gets a 400; a missing secret gets a 500 and a server log. Logs name only the event type and outcome. Teachers are still created on their first visit if the webhook isn't set up.

### Database checks

`pnpm db:check-*` scripts (class limit, student questions, student join, student answers, teacher queue, abuse protection, teacher gaps, self-learner) run race checks against a local or dev database with a mock model. They write and delete rows, so they refuse to run unless `ALLOW_DB_WRITES=1` is set for that one command (for example `ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-abuse-protection`). Don't export it in your shell, and never point them at production.
