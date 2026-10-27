# unpack: Product Brief (draft v0.4, Oct 26, 2026)

## One line
Students read an article, then answer a short AI-generated questionnaire, and they can't move on until the AI says they genuinely tried. It's a reading check that's hard to fake.

## Who it's for
- **Paying customer:** teachers, starting with individual teachers rather than districts.
- **Users:** students from about 2nd/3rd grade and up. No student accounts: they enter a class code and their name.
- **Later:** self-learners improving their own comprehension, through a free tier or browser extension (deferred).

## Core loop
1. Teacher picks a reading (link or pasted text) and gets a class code.
2. Student reads it in unpack.
3. AI generates a few open-ended questions tied to specific details in the passage, plus the student's own take.
4. Student answers. AI grades pass/fail on **effort only** (did they try and not make it up), not quality.
5. On fail, the student gets a specific nudge and revises, up to **3 tries**. On pass, they move on.
6. After 3 fails, the student can submit a **challenge/review** that the teacher reads and resolves.

## What makes it different
Nothing we found ships this full loop. Actively Learn gates but doesn't use AI judgment, Perusall scores effort but doesn't gate, and Brisk takes any text but is a chat. The edge is an **effort gate plus text-specific questions**.

## v1 scope (proposed)
- Teacher: paste a link or text, review/edit questions (optional), share a code.
- Student: join with code + name, read view with copy-paste blocked, questionnaire, AI pass/fail with nudges, 3 tries, then challenge to teacher.
- Teacher visibility: lightweight (who's done, who's stuck) plus a queue of student challenges, not a grade dashboard.
- Cost protection: teacher-owned codes that can be turned on and off, a cap of 150 student question sets per reading, questions cached per reading, join rate limits per code and IP, one effort check per attempt with at most 6 per student per reading, and a bot check on join (planned). No per-teacher AI budget.

## Non-goals for v1
Self-learner extension, district sales/rostering, quality grading, a fixed content library.

## Money
SaaS teacher subscription.
- **Free:** 1 class, no saved library.
- **Paid:** unlimited classes and saved reading libraries.
- Price TBD; comparable tools charge about $8–15/mo per teacher (Diffit, MagicSchool).
- Students are always free. AI usage isn't metered by plan.

## Stack (locked)
Next.js 16 on **Vercel**, **Neon** Postgres (cloud, with a dev branch), and **Clerk** auth (teachers only; students join with a code and name), and **Claude** for AI.

## Risks
- False rejections frustrating struggling readers (handled by 3 tries plus a teacher challenge).
- Child privacy (COPPA/FERPA) because users are young.
- AI cost per retry.
- Incumbents adding a gate.
- Pasted AI answers (lower priority for now; copy-paste blocked, which is a speed bump, not security).

## Open questions
- What's the v1/demo date?
- Where are the existing prompts (local/unpushed)?
