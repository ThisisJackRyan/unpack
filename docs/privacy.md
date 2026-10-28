# unpack: Student and self-learner data and privacy (v1, Oct 27, 2026)

unpack is used by children, so we collect as little as we can and say exactly what we keep. This page lists every place student data is stored, column by column, why it's there, who can see it, and how long it stays. It covers the code as of PR 15 (PR 13 added self-learner accounts, see [Self-learner data](#self-learner-data-added-in-pr-13); PR 15 added the deleted accounts list and the given_back and slot columns); update it with any change to `src/db/schema.ts`.

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

id, student_id, reading_id, created_at, finished_at, outcome (pass/fail/error/given_back). Counts checks toward the limit. A check that failed with no reply from the model (an outage, a timeout, out of credits) is marked given_back (PR 15): it doesn't count toward the limit, only toward a 10-minute window that pauses checking during an outage. No text. Cascade from `students` and `readings`.

### `challenges` (notes to the teacher)

id, student_id, reading_id, round, **note** (the student's note, up to 500 characters), status, resolved_at, resolved_by (the teacher), tries_allowed, checks_allowed, created_at. Cascade from `students` and `readings`.

A teacher's **Give one more try** on the queue's "Out of tries, no note yet" row (PR 18) also writes a `challenges` row, with an **empty note** (`''`; the student wrote nothing): the next round, status denied, resolved_at and resolved_by (that teacher) set, tries_allowed set to the tries used plus 1 and checks_allowed to the checks used plus 2 (one more try and its checks), the same grant as "Deny, give one more try". It holds no text from anyone, is never shown (only an open round shows its note), and is kept and deleted like any other challenge row.

### `join_attempts` (join rate limits)

id, key_kind (ip/code), key_hash, created_at. For an IP, key_hash is an HMAC-SHA256 of the address with a server secret (`JOIN_IP_HASH_SECRET`); the raw IP is never stored. For a code, a SHA-256 of the typed code. **Not linked to any student**: no student id, no name. Rows are deleted by the next join after the 10-minute window, so after a quiet period they can stay longer, until someone joins.

### Not student data

`teachers` (now every Clerk account: teachers and self-learners, see below), `deleted_clerk_users` (above), `classes`, `readings`, `link_fetch_attempts`, `question_generation_attempts`, and `reading_cap_raises` (added in PR 12: which teacher raised a reading's student limit, when, and from and to what) hold teacher data and teacher-side counters only.

### `deleted_clerk_users` (deleted accounts, added in PR 15)

clerk_user_hash, deleted_at, clerk_deleted_at: one row per deleted Clerk account (teacher, self-learner, or an account deleted after an under-13 answer, below), written in the same transaction as the account delete. It holds **only a SHA-256 hash** of the Clerk user id (prefixed, so it can't match another table's hash), never the id, a name, or an email, and nothing about any student. Why: Clerk can deliver a late "account created" event after the delete, and a sign-in session can outlive its account for a moment; either would otherwise create a new, empty account row (with the person's name and email) for someone who deleted their account. With the hash listed, the webhook and the first visit refuse to recreate it. While the Clerk user still exists (for example an under-13 delete whose Clerk call failed, below), the person sees "This account was deleted" and the Clerk delete is tried again; if Clerk has already deleted the user, the visitor is sent to sign in instead. The hash is not keyed with a server secret: Clerk ids are long random strings, so it can't be reversed by guessing, and no secret means nothing to rotate that would silently empty the list. Someone who already has the raw id could only confirm that it was deleted. `clerk_deleted_at` is when Clerk's own delete was confirmed: set at once when the delete came from Clerk (the webhook), and for an under-13 delete (below) when our call to Clerk succeeds, or later by Clerk's own "deleted" event or the retry on the next sign-in. **Kept 30 days** after `clerk_deleted_at`, then deleted by the next account delete (so after a quiet stretch a row can stay a while longer, until the next delete). Clerk's retries end within days, and Clerk never reuses a user id. **A row whose Clerk delete is still pending is kept until Clerk confirms it**, never pruned: that Clerk account (with its email) may still exist in Clerk, and the hash is what stops it from getting a new account row with the name and email. Ops can list these rows (`pnpm ops:list-pending-clerk-deletes`; the hash prefix and age only, and with `--match-clerk` the matching Clerk ids, nothing else from Clerk) and delete those accounts in the Clerk dashboard; Clerk's "deleted" event then confirms the row.

## Self-learner data (added in PR 13)

Self-learners are people **13 or older** who sign in with Clerk and read for themselves. They are not students: no class, no teacher, and no student rows. A reader under 13 can't use this mode (they join a class with a code instead).

### The age screen (PR 15)

Before an account first reads for itself, `/welcome` (or Settings) asks **"When were you born?"** with two dropdowns, birth month and birth year (no answer picked in advance; the years run from this year back 100 years). The page says only "We ask everyone who reads on their own. We don’t save your answer." The server works out from the month and year whether the person is 13 or older for the whole of the current month, and then drops them:

- **Stored:** only that 13+ was confirmed, and when (`age_confirmed_at`, below). Nothing is stored for an under-13 answer except the cookie below.
- **We don't keep under-13 accounts: an under-13 result deletes the account right away.** On `/welcome` (an account that hasn't picked teacher or self-learner yet), an under-13 answer deletes, in the same request, the account row (`teachers`, with the name and email from Clerk) and anything under it, the same delete the Clerk webhook runs, and lists the id's hash in `deleted_clerk_users` so the row can't come back. Then the Clerk account itself is deleted, which ends its sessions, and the action redirects to `/join` ("Let’s get you into a class"). If the Clerk delete fails, it is tried once more; the row is already gone either way, and the next sign-in to that Clerk account tries the Clerk delete again before showing "This account was deleted". Until a Clerk delete succeeds, the hash stays listed as pending and is never pruned (see `deleted_clerk_users` above), and ops can find and finish it. The server log gets one fixed line (`under13_account_delete` with the outcome words, and an error's name and code on a failure), never the Clerk id, the email, the name, or the month or year.
- An account that already has a role is not deleted by the age screen: a teacher who answers under 13 in Settings stays a teacher (with their classes) and is refused self-learner.
- **Never stored, logged, or sent anywhere:** the month and the year. They are not in the database, the server logs, analytics, a URL, a cookie, the browser's storage, an error message, or any prompt to the AI model, and they are not sent back to the page.
- Teachers aren't asked (unchanged from PR 13).

### The age gate cookie (PR 15)

When the answer is under 13, the server sets one cookie on that browser: **`unpack_age_gate`**, value **`under`**, kept **30 days**, httpOnly (page scripts can't read it), Secure in production, SameSite=Lax. It holds **no date, no age and no account id**, only the word "under". While it is there, reading for yourself is refused on that browser without asking again (on `/welcome` and in Settings, checked by the server action, not only the page), and the page points to joining a class with a teacher's code (`/join`) instead. An account with no role yet can't pick anything on `/welcome` while it is there, teacher included: the page shows only the class note and the `/join` button, and the server action refuses any choice. While it is there, `/join` says "Let’s get you into a class" in place of "Join your class". It doesn't affect an account that already has a role (teacher or self-learner), apart from Settings refusing self-learner, or one that confirmed 13+ before. It expires on its own after 30 days, or when the browser's cookies are cleared.

The cookie is not signed, on purpose. It can only ever narrow what a browser may do (refuse reading for yourself, or a first-run choice); nothing reads it to grant anything. So the only thing editing or deleting it can do is undo the block, which anyone can already do by clearing cookies or using another browser. That is a known, accepted limit of an age screen with no identity check (it stops a quick retry with a different date, not a determined person), and signing the cookie wouldn't change it. A forged cookie can only block its own browser.

### `teachers` (the account row), new columns

| Column | What | Why |
|---|---|---|
| role | teacher, self_learner, or null until chosen on `/welcome` | Picks the account's home and which pages and actions it may use. Accounts from before PR 13 were set to teacher. |
| age_confirmed_at | When the account’s age screen answer showed 13 or older, the first time it chose self-learner (before PR 15: when it ticked "I’m 13 or older") | COPPA: self-learner mode is 13+ only. **We never store the birth month or year** (or a birthdate), only that 13+ was confirmed and when. A self-learner row without it is refused by the database. Null for teachers who never chose self-learner. Kept if the account switches back to teacher. |

The name and email in this row come from Clerk, as for teachers.

### `self_readings` (one row per reading a self-learner starts)

id, account_id, title, source_url (if they pasted a link), body_text (the text they pasted or we fetched), grade_level (the level they picked), question_count, status (in progress, passed, moved on), finished_at, questions_claim_token and questions_claimed_at (a random UUID and a time, while their questions are being written), slot_released_at (PR 15: set when writing their questions was tried and failed, so the reading doesn't use one of their 5; not set when it was never tried, for example while they wait out the question limit), created_at. created_at also counts toward the 5 per 7 days allowance, so rows aren't deleted by the self-learner. Cascade from `teachers`.

### `self_questions`

id, reading_id, position, prompt (the AI-written question), created_at. No self-learner input. Cascade from `self_readings`.

### `self_attempts` (one row per try)

id, account_id, reading_id, try_number (1 to 3), result (pass/fail), created_at. Cascade from `teachers` and `self_readings`.

### `self_answers` (one row per answer on a try)

id, attempt_id, question_id, **text** (what they wrote, up to 1,000 characters), ai_pass, ai_feedback (the AI's nudge). Their own writing; they could type anything. Cascade from `self_attempts` and `self_questions`.

### `self_effort_checks` (one row per AI effort check)

id, account_id, reading_id, created_at, finished_at, outcome (pass/fail/error/given_back, as for `effort_checks`). Counts checks toward the limit. No text. Cascade from `teachers` and `self_readings`.

A self-learner's question writes and link fetches are also counted in `question_generation_attempts` and `link_fetch_attempts` (ids and times only, pruned after a day), the same per-account limits teachers have.

### Who can see it

Only the self-learner, signed in. Every self-learner query is scoped to the signed-in account in the statement itself, and reads only `self_*` rows: another account (a teacher, or another self-learner) gets "not found". Teachers never see self-learner data, and self-learners never see class or student data. Operators can reach the database, as above.

### Switching roles

Switching between teacher and self-learner in Settings deletes nothing. A teacher who switches keeps their classes and their students' work (students can still use the class), and a self-learner who switches back sees their readings again.

### How long it stays

Until the Clerk account is deleted. Self-learners can't delete single readings in PR 13. An under-13 answer on `/welcome` deletes the account right away (see The age screen above). When the Clerk account is deleted, the webhook deletes, in the same transaction as the account's classes, all of its `self_readings` (cascading to `self_questions`, `self_attempts`, `self_answers`, and `self_effort_checks`) and then the account row (which removes the role, the age confirmation time, and any self-learner rows left). Every self-learner foreign key is ON DELETE CASCADE. Neon's restore history keeps deleted rows until its window passes, as above.

## Services that receive student data

- **Vercel AI Gateway** (since PR 14) carries every AI request: the reading text (to write questions), and the reading text, the questions, and the student's (or self-learner's) answers (for the effort check). It passes each request to Anthropic and the reply back. **No names, no ids, no session or class data** are sent. We set the gateway to route only to Anthropic (not to other hosts of Claude, such as Amazon Bedrock or Google Vertex AI). This is deliberate: these requests carry children's writing, so we keep the list of processors as short as we can and accept that a call fails (and the try is given back) when Anthropic is down, rather than falling back to another host. Vercel's AI Gateway docs ("Zero Data Retention", read Oct 27, 2026) say the gateway itself "does not retain prompts, outputs, or sensitive data" and that "user data is immediately and permanently deleted after requests are completed". Requests are authenticated with our Vercel project's OIDC token or an AI Gateway API key; neither is ever logged.
- **Anthropic (Claude)** receives the same request from the gateway and writes the reply. A self-learner's requests use solo instructions (no teacher or student wording) but send the same kinds of data. Through the gateway, Anthropic is reached with Vercel's own Anthropic credentials, so Anthropic's handling and retention follow Vercel's agreement with Anthropic and Anthropic's terms; Vercel notes a provider's handling under its agreements may differ from the provider's default policy. We don't state a retention period here. **Open point before launch:** confirm Anthropic's retention through the gateway. **Plan:** turn on the gateway's zero data retention (team-wide, on our Vercel Pro plan) before launch. We won't bring our own Anthropic key (no BYOK): requests go through Vercel's Anthropic credentials, so the zero data retention setting is what governs them.
- **Cloudflare Turnstile** (only when the bot check is turned on): the widget runs in the student's browser on the join page, so Cloudflare receives what any browser request carries (the IP address, browser and device signals) to decide whether it's a person, per Cloudflare's Turnstile terms and privacy policy. Our server sends Cloudflare only the widget's token and our secret, **not** the IP address and not the name.
- **Vercel** (hosting) sees requests, including IP addresses, in its request logs, per Vercel's terms. Our own error logs carry only error names, codes, and ids (no names, answers, or notes). The out-of-credits log (AI Gateway 402) carries the same safe fields.
- **Neon** (database) stores everything above.
- **Clerk** holds teacher and self-learner accounts; no student data. For a self-learner, the age confirmation is ours (`age_confirmed_at`), not sent to Clerk. The teacher's name and email in `teachers` are synced from Clerk: on their first visit, and by the Clerk webhook (`/api/webhooks/clerk`) whenever the Clerk account is created or changed (a change only updates an existing row, so a late change event can't bring back a deleted teacher). When a teacher's Clerk account is deleted, the webhook deletes, in one transaction, their classes (which cascades to the classes' readings and every student and all student work in them, notes to the teacher included), then their self-learner readings and everything under them, and then their `teachers` row (which cascades to their own logs: link fetches, question generations, and limit raises). In the same transaction it lists the Clerk id's hash in `deleted_clerk_users` (see above), so a late "created" event or a leftover session can't bring the account back. A repeat delete changes nothing. An under-13 answer on `/welcome` deletes the Clerk account from our server (see The age screen above); our row is already gone by then, so that webhook delivery changes nothing. Webhook logs carry only the event type and outcome, never a name, email, or id.

## How long it stays

- Student rows and everything under them stay until a teacher deletes them, or the class or teacher account is deleted (each cascades to the class's students and all their work). Deleting the teacher's Clerk account deletes the teacher account here too (through the Clerk webhook).
- **A teacher can delete a reading** from its page (Delete reading, then confirm). It deletes, in one transaction, the reading, its questions (shared and every student's own), and every student's generation rows, call counts, tries, answers, effort checks, and notes to the teacher for that reading. Students and their work on other readings are kept.
- **A teacher can delete one student** from the Class progress page (Delete, then confirm "Delete {name}"). It deletes, in one transaction, the student row (ending their session), their own question sets and generation rows, their call counts, tries, answers, effort checks, and notes to the teacher. Nothing of any other student changes.
- `join_attempts` rows: pruned by later joins after 10 minutes (see above).
- `deleted_clerk_users` rows (a hash only): pruned by later account deletes 30 days after Clerk's delete is confirmed; a row still pending is kept until it is (see above).
- **Accounts that never chose a role** (signed in, but stopped before picking teacher or self-learner on `/welcome`): the Clerk account (with its email) and, if there is one, the `teachers` row with no role (name and email) are deleted by an ops sweep (`pnpm ops:sweep-roleless-clerk-users`, run by hand) **7 days after the account was created and last used** (last signed in or active, as Clerk records it; the sweep reads only those times and the id from Clerk). It deletes our row first, then the Clerk account. What we keep afterwards is only the Clerk id's hash in `deleted_clerk_users`, as for any deleted account (so a late "created" event can't bring the row back), pruned 30 days after Clerk's delete is confirmed. The sweep prints only Clerk ids and hash prefixes, never an email or a name. Until a sweep runs, such an account stays as it is.
- **Backups:** Neon keeps a restore history (point-in-time restore) for the project's restore window, which depends on the Neon plan and settings. Deleted rows can be recovered from it, and stay in it, until that window passes. Keep the window as short as operations allow.

## Unsent answer drafts (in the browser, added in PR 15)

While a student or a self-learner types an answer, the text is also kept in that browser's local storage on that device, so a reload or a dropped connection doesn't lose it. It stays there, on that device only, until the answers are sent for a check that saves (then that try's drafts are removed), the reading is done (passed, out of tries, or a note sent to the teacher), or 7 days after it was last saved: an older draft is treated as gone, and every expired unpack draft on the device is removed the next time an answer or note form loads (PR 16). It never reaches our server until the student sends it. The storage key holds only ids (`unpack:answers:v1:<class or self>:<reading id>:<student or account id>:t<try>:<question id>`) and the value only the answer text and the time it was saved: no name, no class code, nothing else. The student id in the key keeps two students on one shared classroom device from seeing each other's drafts. Where local storage is blocked or full (private browsing, for example), nothing is kept and answering works as before. Clearing the browser's site data removes the drafts.

The note a student writes to their teacher (after the last try, or once every check is used) is kept the same way until it is sent: key `unpack:note:v1:class:<reading id>:<student id>`, value only the note text and the time it was saved, with the same 7 days. It is removed once the note is sent, or when the page no longer offers the note box (the teacher decided, or the reading passed).

## Retry times

Limit notes say when the next try frees up in the visitor's time zone. We read the zone from Vercel's `x-vercel-ip-timezone` request header (derived by Vercel from the IP address) only to format that time on the server; it is never stored or logged. Without it the time is shown in UTC.

## Related

- [v1 features and data model](v1-spec.md)
