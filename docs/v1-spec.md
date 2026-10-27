# unpack: v1 Features & Data Model (v1.1, approved direction, Oct 27, 2026)

## v1 features

**Teacher (Clerk login)**
1. Sign up or log in with Google or email.
2. Create a class, which gets a short join code (free plan: 1 class). The teacher sets the class's **grade level**, which questions and nudges are written for.
3. Add a reading by pasting a link (we extract the text) or pasting text directly.
4. The teacher picks the **number of questions** (1–10, default 3) and a **question mode**:
   - **Same for everyone:** generated once. The teacher can review, edit, and regenerate before publishing.
   - **Unique per student:** each student gets their own AI-generated set when they first open the reading, which makes it harder to share answers. The teacher can view each student's set afterward.
5. Publish the reading to the class.
6. Class progress: each student on each published reading shows as Not started, In progress, Passed, Challenged, or Challenge denied, with tries used. A table on wide screens, one card per student on narrow ones.
7. Challenge queue (with a count on the class page): for each open challenge, the student (first name and initials), the reading, their note, every question with their last try's answer, the effort check's pass or fail and nudge per answer, and tries and checks used. Then one of three buttons: **Accept** (counts as Passed), **Deny**, or **Deny, give one more try**.
8. Join code settings on the class page: a switch to turn the code on or off, and **New code** (with a quick confirm) to replace it.
9. Delete one student and all of their work, from Class progress (a red Delete, then a confirm dialog with "Delete {name}"). See [Student data and privacy](privacy.md).

**Student (no account)**
1. Enter the class code, their **first name, and the first 1–2 letters of their last name** (for example "Maya Ro"). This creates a browser session, and progress is tied to that session, not to the name.
   - If that name is already taken in the class, the student is asked to add another letter.
   - A student on a new device starts fresh. Progress does **not** carry over by name.
2. See the class's published readings.
3. Read in a clean view with copy and paste blocked.
4. Answer the questions and submit. The AI returns pass or fail per answer, with a short nudge on each fail.
5. Up to 3 tries. After the 3rd fail (or once every effort check is used without a pass), they can submit a challenge note to the teacher.
6. Passed readings are marked done, showing the passing answers. The class home shows each reading as Not started, In progress, Passed, Challenged, or Challenge denied.
7. When the teacher decides: Accept shows the reading as Passed ("Your teacher accepted your answers."); Deny shows a kind message and no form; Deny with one more try brings the answer form back with "1 try left".

**Later (not v1):** saved reading libraries (paid), unlimited classes (paid), billing, the self-learner extension, and export to Google Classroom.

## Data model (Postgres / Neon)

| Table | Key fields |
|---|---|
| teachers | id, clerk_user_id, name, email, plan (free/paid), created_at |
| classes | id, teacher_id, name, grade_level, join_code (unique), code_active, created_at |
| readings | id, class_id, title, source_url, body_text, grade_level (overrides the class; optional), question_count, question_mode (shared/per_student), status (draft/published), created_at |
| questions | id, reading_id, student_id (null when shared), position, prompt, created_at |
| students | id, class_id, first_name, last_initials, name_key (unique per class, normalized), session_token_hash (SHA-256 of the cookie token, unique), created_at |
| student_question_calls | id, reading_id, student_id, created_at. One row per AI call for a student's own question set, for the "Try again" limit. Kept until the student or reading is deleted. |
| join_attempts | id, key_kind (ip/code), key_hash, created_at. Per-IP keys are HMAC-SHA256, per-code keys SHA-256; pruned after the 10-minute window. |
| attempts | id, student_id, reading_id, try_number (1 to 3, or more after a teacher's one more try), result (pass/fail), created_at |
| answers | id, attempt_id, question_id, text, ai_pass (bool), ai_feedback |
| challenges | id, student_id, reading_id, round (1, then +1 per new note after one more try), note, status (open/approved/denied/closed), resolved_at, resolved_by (the teacher; null for an auto-close), tries_allowed and checks_allowed (set only by Deny with one more try), created_at. Unique per student, reading, and round. |
| effort_checks | id, student_id, reading_id, created_at, finished_at, outcome (pass/fail/error). One row per effort check started: the in-flight claim while unfinished, and the per-student, per-reading check counter. Kept, no answer text. |

Student status for a reading is derived from attempts, effort checks, and the latest challenge round, by one function for both the student and the teacher: **Passed** if any attempt passed or the latest challenge was accepted; **Challenged** if it is open; **Challenge denied** if it was denied without one more try; **In progress** after any try, once every effort check is used, or after a denial with one more try; else **Not started**.

## Key rules
- An attempt passes only when **every** answer passes the effort check.
- Try 4 is blocked; only the challenge option appears (unless the teacher gives one more try, below).
- Answers: each is trimmed and cleaned (control characters removed), then must be 1 to 1,000 characters. Every question is answered on every try, in one submit; after a failed try, the last answers are filled back in, with each answer's result and nudge.
- One effort check (one AI call) per attempt covers every answer. At most 1 check runs at a time per student and reading; a second submit meanwhile is told to wait.
- Effort checks per student per reading, for all time: **6 by default, +2 per teacher grant** (each "Deny, give one more try" sets the limit to checks used + 2). The 6 are the 3 tries plus room for AI failures. If the AI call fails or times out (60 seconds), the try isn't used up, but the check still counts, and the student is asked to wait a minute before trying again. A check whose result couldn't be saved (a database error) also counts without using a try: a save that always fails must not become an endless loop of paid checks. Its claim is finished right away, so the student isn't told "still checking" for 90 seconds. Once every allowed check is used without a pass, the answer form goes away (even with tries left) and the challenge note opens instead.
- Challenge note: 1 to 500 characters, cleaned like answers. Only with no pass, once out of tries or effort checks (the student's own limits), with no open, accepted, or plainly denied challenge, and only one open at a time.
- A note can't be sent while an effort check is still running for that student and reading (for example the last allowed check in another tab, which could still pass): the student sees "We’re still checking your answers. Try again in a minute." The note insert takes the same lock as the check, so nothing slips in between.
- Accept and Deny: only the owning teacher, only while the challenge is open. One decision per challenge: a double-click or a second tab gets "Already decided" and the list refreshes. Ownership, "still open", and the grant are checked in the same transaction as the update. Nothing is deleted: attempts, answers, effort checks, and the challenge all stay.
- Deny, give one more try (its own button, so it can't be left ticked and ignored on Accept): the student gets exactly 1 try left, and effort check headroom for it: tries allowed become tries used + 1, and checks allowed become checks used + 2 (1 for the try, 1 spare for an AI failure). A student who reached the check limit with tries unused also gets exactly 1 try (not their unused ones back). Granting twice at once applies once.
- After one more try: if it passes, the reading is Passed. If it fails (or both checks fail on our side), the student can send a new note, which is a new challenge round; the teacher decides it like the first, and may give one more try again. Earlier rounds keep their decision.
- A challenge from a student who passes later is closed in the same transaction as the passing try (status closed), and the queue never lists a student who has passed.
- Copy and paste blocking (the reading text and the answer boxes: copy, cut, paste, drag and drop, the context menu, select all, and text selection) is a speed bump, not security. A determined student can get around it; the effort check is the real gate. The trade-off: blocking selection also breaks select-to-read tools (Read&Write, the browser's read-selected-text) and right-click spellcheck in the answer boxes. A teacher setting to turn it off may come later.
- Shared mode: questions are cached per reading. Per-student mode: each student's set is generated once and cached, and it isn't regenerated on retries.
- Shared mode: the question count stays the teacher's number. Deleting a question lowers it by 1 (never below 1), and publishing needs exactly that many questions. Changing a draft's text, grade, count, or mode clears its shared questions.
- Once published, only the title can be edited; the text, grade, question count, mode, and questions stay locked. This applies to both modes.
- Per-student mode, "Try again" limit: a failed question write saves nothing, and the student sees "Try again". Each AI call for a student's own set counts (only real calls: an open that finds the set, waits on another tab, or is refused adds nothing). At most **3 calls per student per reading in 10 minutes**; past that the student sees "Let’s take a little break. Try again in a few minutes." At most **6 for all time**; past that, "Ask your teacher for help with this one." The count is taken under the same lock as the claim, so a burst of Try agains makes exactly the limit of calls. Without an AI key, the open fails before counting.
- Per-student mode: each reading allows at most 150 student question sets. Past that, a new student sees "Ask your teacher for help with this one." A student who already has a set keeps it.
- Changing a class's grade clears the shared questions of its draft readings that use the class grade (no reading override). Published readings and drafts with an override are untouched.
- Question generation is limited to 30 per teacher per 10 minutes (generate, regenerate, and previews). Students' own sets in per-student mode don't count toward it.
- Free plan: creating a 2nd class is blocked.
- Readings: the text must be 200 to 20,000 characters after cleanup (line endings, control characters, extra blank lines). A longer article is refused, never cut. Titles are up to 120 characters, links up to 2,048.
- Link fetching: limited to 20 per teacher per 10 minutes (pasted text isn't limited). We only fetch http/https links to public hosts, with 8 seconds and 2 MB per fetch, and only HTML pages.
- Joining: a student enters the class code, their first name (up to 30 letters; spaces, hyphens, apostrophes, and the ʻokina are OK), and the first 1 or 2 letters of their last name. Nothing else is collected.
- First names start with a letter, or with one ʻokina or apostrophe before a letter ("ʻIolani", or "'Iolani" from a keyboard without an ʻokina). They end with a letter, never start with a hyphen, and can't be only marks or punctuation.
- A name already taken in the class is refused with "Someone already has that name. Add another letter." It is never resumed: progress does not carry over by name. "Taken" compares a folded key: case, extra spaces, apostrophes and the ʻokina, and Latin accents are ignored, and a hyphen counts as a space. So "Keʻala" and "Keala", "Zoë" and "Zoe", "D’Andre" and "DAndre", and "Jean-Luc" and "Jean Luc" are the same name; "Mary Ann" and "Maryann" are not. What the student typed is what the teacher sees.
- Changing the folding changes every name key. Existing students keep their old keys until they are recomputed with `pnpm db:recompute-name-keys` (a dry run unless ALLOW_DB_WRITES=1; names that now collide are counted and left as they are, for the teacher). No real data exists yet, so nothing needs recomputing for this change.
- Joining needs the class code to be on. An unknown code and a code that's off get the same message ("We couldn’t find that class code. Check it with your teacher."). Students who already joined keep access when the code is turned off, and when it is replaced: a session is tied to the student and class, never to the code.
- Join code on/off and New code: only the owning teacher (checked in the update itself). On/off saves the value asked for, so a double click lands where the teacher pointed. New code is one update, retried with a fresh code if another class has it; concurrent New codes end with exactly one current code, and the old code stops working as soon as it commits. Neither is destructive (no red), but New code asks for a quick confirm because the old code stops working.
- Joining is rate limited to 60 tries per IP and 100 per code, each per 10 minutes. Every try that passes the bot check counts, including a wrong code or a taken name.
- Bot check on joining (Cloudflare Turnstile): on only when both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set. Off (neither set), the join form has no widget and the server makes no call. Only one set refuses every join and logs which is missing. When on, the widget sits under the form fields, and the server verifies its token with Turnstile's siteverify (5-second timeout; only the secret and the token are sent, never the student's IP). It fails closed: a missing token gets "Finish the check above the button, then try again."; a failed, expired, or reused token, a token made for another action, a timeout, a network error, or a reply that isn't JSON gets "We couldn’t check that you’re a person. Try again in a moment." Order: form validation, then the bot check, then the rate limits, then the join, so a bot that can't pass the check can't use up a code's or a school's tries. Each token is single use; the widget resets after every submit.
- Bot check on teacher sign-up: Clerk's own **Challenge suspicious sign-ups** (Clerk Dashboard, Protect, Protections; Clerk docs: clerk.com/docs/guides/protect/bot-protection, read Oct 27, 2026). We don't control Clerk's sign-up page, so we add no widget and no keys for it. What it covers:
  - It's on by default for new Clerk applications and included on every plan. At deploy, check that its row on the Protections page says Active. An older application may instead show a legacy "Bot sign-up protection" row; enable that or take Clerk's Update to the new one.
  - Sign-ups only. It never challenges a sign-in. Teacher sign-in has no bot check of ours (Clerk's own sign-in protections, such as locking accounts after failed sign-ins, are Clerk settings).
  - With the default setting (Suspicious), only sign-ups that Clerk flags as automated, or that come through a VPN, Tor, or a residential or data center proxy, are challenged; other sign-ups see nothing. Challenging every sign-up ("All") needs Clerk's Business plan.
  - A challenged sign-up runs a Cloudflare Turnstile check in the browser (usually invisible, sometimes a CAPTCHA). Our prebuilt `<SignUp />` shows it inside the form. If it fails, no account is created, so no `teachers` row is ever made for it.
  - Our Turnstile keys cover the student join only.
- If a Content-Security-Policy is ever added, allow `https://challenges.cloudflare.com` in script-src and frame-src (our Turnstile and Clerk's sign-up challenge both need it; Clerk lists its own CSP requirements). There is none today.
- These limits are first estimates. A school behind one shared IP can hit 60 tries per IP if several classes join at once. With the bot check on, junk tries on a real code need a solved check each, which makes blocking a code for 10 minutes much harder; a teacher can also make a New code. The numbers stay as they are until real use says otherwise.
- IP addresses are stored only as a keyed hash (HMAC-SHA256 with a server secret), only for the join rate limit. Rows are deleted by the next join after the 10-minute window (so after a quiet period they can stay longer), and Neon's restore history keeps deleted rows for its restore window.
- A student's session is an httpOnly cookie that lasts 180 days. Only a hash of its token is stored. Joining a different class on the same device replaces the session.
- Student data is visible only to the owning teacher, and we store only first names plus last initials. Exactly what is stored, who sees it, and how long it stays: [Student data and privacy](privacy.md).
- Deleting a student (owning teacher only): one statement deletes the student row, with ownership checked in it, and the database cascades to everything under them in the same transaction: their own question sets and generation rows, AI call counts, tries, answers, effort checks, and challenges. Their session ends with the row. Other students are untouched. Neon's restore history keeps deleted rows until its window passes.

## AI calls
1. **Generate questions** (once per reading, or once per student in per-student mode): open-ended questions tied to specific details in the text, plus one "what do you think" question, written for the teacher-chosen grade level.
2. **Effort check** (per attempt): one call, given the text and every question with its answer, returns pass or fail per answer and a nudge on each fail. The bar is "did they try and engage with the text and the question," never quality, spelling, grammar, or correctness. Short but genuine answers and opinions pass; "idk", gibberish, a copy of the question, and off-topic answers fail. It writes for the reading's grade (the reading's own grade, else the class's), and treats the text and answers as data, never as instructions.
   - Nudges: at most 140 characters, kind and specific (what to look at or add), never giving away an answer, never shaming. Dashes are removed and longer nudges are shortened before a student sees them.

## Decided
- AI provider: **Claude** (Anthropic API) for both question generation and the effort check.
