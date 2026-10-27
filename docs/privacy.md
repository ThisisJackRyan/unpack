# unpack: Student and self-learner data and privacy (v1, Oct 27, 2026)

unpack is used by children, so we collect as little as we can and say exactly what we keep. This page lists every place student data is stored, column by column, why it's there, who can see it, and how long it stays. It covers the code as of PR 13 (which added self-learner accounts; see [Self-learner data](#self-learner-data-added-in-pr-13)); update it with any change to `src/db/schema.ts`.

## What a student gives us

Only three things, on the join form: the class code, a **first name** (up to 30 letters), and the **first 1 or 2 letters of their last name**. No email, no password, no birthday, no account. After that, the student's answers and notes to their teacher.

## Who can see it

- **The student's teacher** (the class owner, signed in with Clerk) sees the student's name as typed, their status on each reading, their tries, answers, the AI's nudges, and their notes. Every teacher query and action is scoped to the owning teacher in the database statement itself; another teacher gets "not found".
- **The student**, on their own device (the session cookie), sees their own class, readings, answers, and results.
- **Nobody else** in the app: there are no other student or public views.
- **Operators** (the people running unpack) can reach the database for support and fixes.

## Table by table

All tables below live in Neon Postgres. "Cascade" means the row is deleted automatically, in the same transaction, when the row it points to is deleted.

### `students` (one row per student who joined)

| Column | What | Why |
|---|---|---|
| id | Random UUID | Links the student's work. |
| class_id | The class joined | Scopes the student to one class and teacher. Cascade from `classes`. |
| first_name | First name as typed (for example "Maya") | So the teacher knows who it is. |
| last_initials | 1 or 2 letters (for example "Ro") | Tells apart two students with the same first name. |
| name_key | A folded copy of the name (case, accents, apostrophes ignored) | Stops two students taking the same name in one class. |
| session_token_hash | SHA-256 of the random token in the student's cookie | Recognizes the student's browser. The raw token is only in the cookie (httpOnly, 180 days). |
| created_at | When they joined | Ordering. |

The session is this row: there is no separate sessions table. Deleting the row ends the session (the cookie then finds nobody, and the student is sent to the join form).

### `questions` (per-student question sets)

Rows with a `student_id` are one student's own AI-written questions (unique per student mode): id, reading_id, student_id, position, prompt (the question text), created_at. No student input is in them. Shared questions have no `student_id` and aren't student data. Cascade from `students` and `readings`.

### `question_generations` (one row per student per reading, in unique per student mode)

reading_id, student_id, status (pending/done), claim_token (a random UUID), claimed_at, created_at. Makes sure a student's set is written once. No text. Cascade from `students` and `readings`.

### `student_question_calls` (added in PR 11)

id, reading_id, student_id, created_at, given_back (added in PR 12): one row per AI call made for a student's own question set, for the "Try again" limit. No text. A call that fails without a response from the model (outage, bad key, timeout) has its row marked given_back when it ends: it still counts toward the 10-minute window, not toward the all-time limit. Kept until the student or reading is deleted (the all-time limit needs them), or until the teacher uses "Let them try again", which deletes that student's rows for that reading. Cascade from `students` and `readings`.

### `attempts` (one row per try)

id, student_id, reading_id, try_number, result (pass/fail), created_at. Cascade from `students` and `readings`.

### `answers` (one row per answer on a try)

id, attempt_id, question_id, **text** (what the student wrote, up to 1,000 characters), ai_pass, ai_feedback (the AI's nudge). This is the student's own writing; students are not asked for personal details, but they could type anything. Cascade from `attempts` and `questions`.

### `effort_checks` (one row per AI effort check)

id, student_id, reading_id, created_at, finished_at, outcome (pass/fail/error). Counts checks toward the limit. No text. Cascade from `students` and `readings`.

### `challenges` (notes to the teacher)

id, student_id, reading_id, round, **note** (the student's note, up to 500 characters), status, resolved_at, resolved_by (the teacher), tries_allowed, checks_allowed, created_at. Cascade from `students` and `readings`.

### `join_attempts` (join rate limits)

id, key_kind (ip/code), key_hash, created_at. For an IP, key_hash is an HMAC-SHA256 of the address with a server secret (`JOIN_IP_HASH_SECRET`); the raw IP is never stored. For a code, a SHA-256 of the typed code. **Not linked to any student**: no student id, no name. Rows are deleted by the next join after the 10-minute window, so after a quiet period they can stay longer, until someone joins.

### Not student data

`teachers` (now every Clerk account: teachers and self-learners, see below), `classes`, `readings`, `link_fetch_attempts`, `question_generation_attempts`, and `reading_cap_raises` (added in PR 12: which teacher raised a reading's student limit, when, and from and to what) hold teacher data and teacher-side counters only.

## Self-learner data (added in PR 13)

Self-learners are people **13 or older** who sign in with Clerk and read for themselves. They are not students: no class, no teacher, and no student rows. A reader under 13 can't use this mode (they join a class with a code instead).

### `teachers` (the account row), new columns

| Column | What | Why |
|---|---|---|
| role | teacher, self_learner, or null until chosen on `/welcome` | Picks the account's home and which pages and actions it may use. Accounts from before PR 13 were set to teacher. |
| age_confirmed_at | When the account ticked "I’m 13 or older", the first time it chose self-learner | COPPA: self-learner mode is 13+ only. **We never ask for or store a birthdate**, only that it was confirmed and when. A self-learner row without it is refused by the database. Null for teachers who never chose self-learner. Kept if the account switches back to teacher. |

The name and email in this row come from Clerk, as for teachers.

### `self_readings` (one row per reading a self-learner starts)

id, account_id, title, source_url (if they pasted a link), body_text (the text they pasted or we fetched), grade_level (the level they picked), question_count, status (in progress, passed, moved on), finished_at, questions_claim_token and questions_claimed_at (a random UUID and a time, while their questions are being written), created_at. created_at also counts toward the 5 per 7 days allowance, so rows aren't deleted by the self-learner. Cascade from `teachers`.

### `self_questions`

id, reading_id, position, prompt (the AI-written question), created_at. No self-learner input. Cascade from `self_readings`.

### `self_attempts` (one row per try)

id, account_id, reading_id, try_number (1 to 3), result (pass/fail), created_at. Cascade from `teachers` and `self_readings`.

### `self_answers` (one row per answer on a try)

id, attempt_id, question_id, **text** (what they wrote, up to 1,000 characters), ai_pass, ai_feedback (the AI's nudge). Their own writing; they could type anything. Cascade from `self_attempts` and `self_questions`.

### `self_effort_checks` (one row per AI effort check)

id, account_id, reading_id, created_at, finished_at, outcome (pass/fail/error). Counts checks toward the limit. No text. Cascade from `teachers` and `self_readings`.

A self-learner's question writes and link fetches are also counted in `question_generation_attempts` and `link_fetch_attempts` (ids and times only, pruned after a day), the same per-account limits teachers have.

### Who can see it

Only the self-learner, signed in. Every self-learner query is scoped to the signed-in account in the statement itself, and reads only `self_*` rows: another account (a teacher, or another self-learner) gets "not found". Teachers never see self-learner data, and self-learners never see class or student data. Operators can reach the database, as above.

### Switching roles

Switching between teacher and self-learner in Settings deletes nothing. A teacher who switches keeps their classes and their students' work (students can still use the class), and a self-learner who switches back sees their readings again.

### How long it stays

Until the Clerk account is deleted. Self-learners can't delete single readings in PR 13. When the Clerk account is deleted, the webhook deletes, in the same transaction as the account's classes, all of its `self_readings` (cascading to `self_questions`, `self_attempts`, `self_answers`, and `self_effort_checks`) and then the account row (which removes the role, the age confirmation time, and any self-learner rows left). Every self-learner foreign key is ON DELETE CASCADE. Neon's restore history keeps deleted rows until its window passes, as above.

## Services that receive student data

- **Vercel AI Gateway** (since PR 14) carries every AI request: the reading text (to write questions), and the reading text, the questions, and the student's (or self-learner's) answers (for the effort check). It passes each request to Anthropic and the reply back. **No names, no ids, no session or class data** are sent. We set the gateway to route only to Anthropic (not to other hosts of Claude, such as Amazon Bedrock or Google Vertex AI). Vercel's AI Gateway docs ("Zero Data Retention", read Oct 27, 2026) say the gateway itself "does not retain prompts, outputs, or sensitive data" and that "user data is immediately and permanently deleted after requests are completed". Requests are authenticated with our Vercel project's OIDC token or an AI Gateway API key; neither is ever logged.
- **Anthropic (Claude)** receives the same request from the gateway and writes the reply. A self-learner's requests use solo instructions (no teacher or student wording) but send the same kinds of data. Through the gateway, Anthropic is reached with Vercel's own Anthropic credentials, so Anthropic's handling and retention follow Vercel's agreement with Anthropic and Anthropic's terms; Vercel notes a provider's handling under its agreements may differ from the provider's default policy. We don't state a retention period here. **Open point before launch:** confirm Anthropic's retention through the gateway, and decide whether to turn on the gateway's zero data retention option (per request or team-wide; Vercel lists it for Pro and Enterprise plans) or bring our own Anthropic key (BYOK) so our own terms with Anthropic apply.
- **Cloudflare Turnstile** (only when the bot check is turned on): the widget runs in the student's browser on the join page, so Cloudflare receives what any browser request carries (the IP address, browser and device signals) to decide whether it's a person, per Cloudflare's Turnstile terms and privacy policy. Our server sends Cloudflare only the widget's token and our secret, **not** the IP address and not the name.
- **Vercel** (hosting) sees requests, including IP addresses, in its request logs, per Vercel's terms. Our own error logs carry only error names, codes, and ids (no names, answers, or notes).
- **Neon** (database) stores everything above.
- **Clerk** holds teacher and self-learner accounts; no student data. For a self-learner, the age confirmation is ours (`age_confirmed_at`), not sent to Clerk. The teacher's name and email in `teachers` are synced from Clerk: on their first visit, and by the Clerk webhook (`/api/webhooks/clerk`) whenever the Clerk account is created or changed (a change only updates an existing row, so a late change event can't bring back a deleted teacher). When a teacher's Clerk account is deleted, the webhook deletes, in one transaction, their classes (which cascades to the classes' readings and every student and all student work in them, notes to the teacher included), then their self-learner readings and everything under them, and then their `teachers` row (which cascades to their own logs: link fetches, question generations, and limit raises). A repeat delete changes nothing. Webhook logs carry only the event type and outcome, never a name, email, or id.

## How long it stays

- Student rows and everything under them stay until a teacher deletes them, or the class or teacher account is deleted (each cascades to the class's students and all their work). Deleting the teacher's Clerk account deletes the teacher account here too (through the Clerk webhook).
- **A teacher can delete a reading** from its page (Delete reading, then confirm). It deletes, in one transaction, the reading, its questions (shared and every student's own), and every student's generation rows, call counts, tries, answers, effort checks, and notes to the teacher for that reading. Students and their work on other readings are kept.
- **A teacher can delete one student** from the Class progress page (Delete, then confirm "Delete {name}"). It deletes, in one transaction, the student row (ending their session), their own question sets and generation rows, their call counts, tries, answers, effort checks, and notes to the teacher. Nothing of any other student changes.
- `join_attempts` rows: pruned by later joins after 10 minutes (see above).
- **Backups:** Neon keeps a restore history (point-in-time restore) for the project's restore window, which depends on the Neon plan and settings. Deleted rows can be recovered from it, and stay in it, until that window passes. Keep the window as short as operations allow.

## Related

- [v1 features and data model](v1-spec.md)
