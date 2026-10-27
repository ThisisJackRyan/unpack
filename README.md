# unpack

A reading check that's hard to fake: students read a text, then answer AI-generated questions about it, and they move on only when they've genuinely tried.

## Core loop

1. A teacher picks a reading (link or pasted text) and shares a class code.
2. A student joins with the code and reads the text in unpack.
3. AI generates a few open-ended questions tied to specific details in the passage, plus one asking for the student's own take.
4. The student answers. AI grades pass/fail on **effort only** (did they try and engage with the text), not quality.
5. On a fail, the student gets a specific nudge and revises, up to 3 tries. On a pass, they move on.
6. After 3 fails, the student can send a challenge that the teacher reviews and resolves.

## Stack (locked)

- [Next.js 16](https://nextjs.org) on [Vercel](https://vercel.com)
- [Neon](https://neon.tech) Postgres
- [Clerk](https://clerk.com) auth for **teachers only**. Students have no accounts: they join with a class code, their first name, and the first 1-2 letters of their last name.
- [Claude](https://www.anthropic.com/claude) via the Anthropic API for question generation and the effort check

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
pnpm test      # unit tests (no network; the Anthropic SDK is mocked)
```

Copy `.env.example` to `.env.local` and fill it in. `ANTHROPIC_API_KEY` is needed for question generation (without it, teachers see "Question writing isn’t set up yet."); `ANTHROPIC_MODEL` is optional and defaults to `claude-sonnet-5-5`. The question request (`output_config.effort`, strict tools, auto tool choice) targets current 5.x models; an older `ANTHROPIC_MODEL` may return a 400.

The student join form's bot check (Cloudflare Turnstile) is on only when both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set; leave both empty for local dev, or use Cloudflare's public test keys (see `.env.example`). Teacher sign-up's bot check is Clerk's own "Challenge suspicious sign-ups" (Clerk Dashboard, Protect, Protections), on by default for new Clerk apps; see the v1 spec for exactly what it covers.

### Database checks

`pnpm db:check-*` scripts (class limit, student questions, student join, student answers, teacher queue, abuse protection) run race checks against a local or dev database with a mock model. They write and delete rows, so they refuse to run unless `ALLOW_DB_WRITES=1` is set for that one command (for example `ALLOW_DB_WRITES=1 DATABASE_URL=... pnpm db:check-abuse-protection`). Don't export it in your shell, and never point them at production.
