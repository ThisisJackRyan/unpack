# unpack: Product Brief (draft v0.6, Oct 27, 2026)

## One line
Students read an article, then answer a short AI-generated questionnaire, and they can't move on until the AI says they genuinely tried. It's a reading check that's hard to fake.

## Who it's for
- **Paying customer:** teachers, starting with individual teachers rather than districts.
- **Users:** students from about 2nd/3rd grade and up. No student accounts: they enter a class code and their name.
- **Self-learners (PR 13):** people 13 or older reading for themselves. They sign in with Clerk, choose "I’m reading for myself", and use the same read, answer, and effort check loop on anything they paste, with 5 new readings per rolling 7 days free. No class, no teacher, no challenge. A paid self-learner plan is TBD.
- **Later:** a browser extension (deferred).

## Core loop
1. Teacher picks a reading (link or pasted text) and gets a class code.
2. Student reads it in unpack.
3. AI generates a few open-ended questions tied to specific details in the passage, plus the student's own take.
4. Student answers. AI grades pass/fail on **effort only** (did they try and not make it up), not quality.
5. On fail, the student gets a specific nudge and revises, up to **3 tries**. On pass, they move on.
6. After 3 tries, the student can send their teacher a **note**. The teacher can **Accept** it (the reading counts as Passed) or **Deny** it, optionally giving **one more try**. Extra tries are the teacher's call, one at a time, with no cap.

## Self-learner loop (PR 13)
1. After signing in, a new account picks "I’m a teacher" or "I’m reading for myself" (confirming they're 13 or older). It can switch later in Settings; nothing is deleted on a switch.
2. They paste a link or text and pick a reading level and number of questions.
3. AI writes their own questions for that reading.
4. They answer; the same effort check gives pass or fail with nudges, up to 3 tries.
5. A pass marks the reading Passed. After the 3rd failed try they see the nudges and move on (Moved on). No note, no challenge.
6. History lists every reading with its date, level, and result.

## What makes it different
Nothing we found ships this full loop. Actively Learn gates but doesn't use AI judgment, Perusall scores effort but doesn't gate, and Brisk takes any text but is a chat. The edge is an **effort gate plus text-specific questions**.

## v1 scope (proposed)
- Teacher: paste a link or text, review/edit questions (optional), share a code.
- Student: join with code + name, read view with copy-paste blocked, questionnaire, AI pass/fail with nudges, 3 tries, then a note to the teacher (Accept counts as Passed; Deny, optionally with one more try).
- Teacher visibility: lightweight (who's done, who's stuck) plus a queue of student challenges, not a grade dashboard.
- Cost protection: teacher-owned codes that can be turned on and off or replaced, a cap of 150 student question sets per reading (a teacher can raise it once per reading, to 300, and the raise is logged), a "Try again" limit on each student's own question set (3 AI calls per 10 minutes, counting every call, including failed ones given back; 6 in all, counting only calls the model answered; a teacher can reset it with "Let them try again"), questions cached per reading, join rate limits per code and IP, one effort check per attempt with 6 per student per reading by default (+2 with each extra try a teacher gives), and a bot check on join (Cloudflare Turnstile; teacher sign-up uses Clerk's own "Challenge suspicious sign-ups"). No per-teacher AI budget.

## Non-goals for v1
Self-learner browser extension, district sales/rostering, quality grading, a fixed content library.

## Money
SaaS teacher subscription.
- **Free:** 1 class, no saved library.
- **Paid:** unlimited classes and saved reading libraries.
- Price TBD; comparable tools charge about $8–15/mo per teacher (Diffit, MagicSchool).
- Students are always free. AI usage isn't metered by plan.
- **Self-learners:** free plan, 5 new readings per rolling 7 days. Paid self-learner plan TBD (the allowance is one function keyed by plan, ready for it).

## Stack (locked)
Next.js 16 on **Vercel**, **Neon** Postgres (cloud, with a dev branch), and **Clerk** auth (teachers and self-learners; students join with a code and name), and **Claude** for AI.

## Risks
- False rejections frustrating struggling readers (handled by 3 tries plus a teacher challenge).
- Child privacy (COPPA/FERPA) because users are young. Self-learner accounts are 13+ only (a confirmation checkbox; no birthdate stored); younger readers use a class code. What we store and for how long: [Student data and privacy](privacy.md). Teachers can delete a student and all of their work.
- AI cost per retry.
- Incumbents adding a gate.
- Pasted AI answers (lower priority for now; copy-paste blocked, which is a speed bump, not security).

## Open questions
- What's the v1/demo date?
- Where are the existing prompts (local/unpushed)?
