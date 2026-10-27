# unpack: v1 Features & Data Model (v1.0, approved direction, Oct 26, 2026)

## v1 features

**Teacher (Clerk login)**
1. Sign up or log in with Google or email.
2. Create a class, which gets a short join code (free plan: 1 class). The teacher sets the class's **grade level**, which questions and nudges are written for.
3. Add a reading by pasting a link (we extract the text) or pasting text directly.
4. The teacher picks the **number of questions** (1–10, default 3) and a **question mode**:
   - **Same for everyone:** generated once. The teacher can review, edit, and regenerate before publishing.
   - **Unique per student:** each student gets their own AI-generated set when they first open the reading, which makes it harder to share answers. The teacher can view each student's set afterward.
5. Publish the reading to the class.
6. Class view: each student shows as Not started, In progress, Passed, or Challenged.
7. Challenge queue: read the student's answers, the AI's reasons, and the student's note, then Approve (counts as passed) or Deny.
   - **Not shipped yet:** items 6 and 7 (the class view and the challenge queue with Approve and Deny) come in the next PR. Until then students can send notes but teachers can't see or resolve them, so don't use this with real classes until it lands.
8. Turn a join code on or off.

**Student (no account)**
1. Enter the class code, their **first name, and the first 1–2 letters of their last name** (for example "Maya Ro"). This creates a browser session, and progress is tied to that session, not to the name.
   - If that name is already taken in the class, the student is asked to add another letter.
   - A student on a new device starts fresh. Progress does **not** carry over by name.
2. See the class's published readings.
3. Read in a clean view with copy and paste blocked.
4. Answer the questions and submit. The AI returns pass or fail per answer, with a short nudge on each fail.
5. Up to 3 tries. After the 3rd fail (or once all 6 effort checks are used without a pass), they can submit a challenge note to the teacher.
6. Passed readings are marked done, showing the passing answers. The class home shows each reading as Not started, In progress, Passed, or Challenged.

**Later (not v1):** saved reading libraries (paid), unlimited classes (paid), billing, the self-learner extension, and export to Google Classroom.

## Data model (Postgres / Neon)

| Table | Key fields |
|---|---|
| teachers | id, clerk_user_id, name, email, plan (free/paid), created_at |
| classes | id, teacher_id, name, grade_level, join_code (unique), code_active, created_at |
| readings | id, class_id, title, source_url, body_text, grade_level (overrides the class; optional), question_count, question_mode (shared/per_student), status (draft/published), created_at |
| questions | id, reading_id, student_id (null when shared), position, prompt, created_at |
| students | id, class_id, first_name, last_initials, name_key (unique per class, normalized), session_token_hash (SHA-256 of the cookie token, unique), created_at |
| join_attempts | id, key_kind (ip/code), key_hash, created_at. Per-IP keys are HMAC-SHA256, per-code keys SHA-256; pruned after the 10-minute window. |
| attempts | id, student_id, reading_id, try_number (1–3), result (pass/fail), created_at |
| answers | id, attempt_id, question_id, text, ai_pass (bool), ai_feedback |
| challenges | id, student_id, reading_id, note, status (open/approved/denied), resolved_at. One per student per reading (unique). |
| effort_checks | id, student_id, reading_id, created_at, finished_at, outcome (pass/fail/error). One row per effort check started: the in-flight claim while unfinished, and the per-student, per-reading check counter. Kept, no answer text. |

Student status for a reading is derived from attempts and challenges: Passed if any attempt passed or a challenge was approved, Challenged if a challenge is open, In progress after any try (or a denied challenge, or once all 6 effort checks are used), else Not started.

## Key rules
- An attempt passes only when **every** answer passes the effort check.
- Try 4 is blocked; only the challenge option appears.
- Answers: each is trimmed and cleaned (control characters removed), then must be 1 to 1,000 characters. Every question is answered on every try, in one submit; after a failed try, the last answers are filled back in, with each answer's result and nudge.
- One effort check (one AI call) per attempt covers every answer. At most 1 check runs at a time per student and reading; a second submit meanwhile is told to wait.
- Effort checks are limited to 6 per student per reading, for all time: the 3 tries plus room for AI failures. If the AI call fails or times out (60 seconds), the try isn't used up, but the check still counts, and the student is asked to wait a minute before trying again. A check whose result couldn't be saved (a database error) also counts without using a try: a save that always fails must not become an endless loop of paid checks. Its claim is finished right away, so the student isn't told "still checking" for 90 seconds. Once 6 checks are used without a pass, the answer form goes away (even with tries left) and the challenge note opens instead.
- Challenge note: 1 to 500 characters, cleaned like answers. Only with no pass, after 3 failed tries or once 6 effort checks are used, and only one per student per reading.
- Copy and paste blocking (the reading text and the answer boxes: copy, cut, paste, drag and drop, the context menu, select all, and text selection) is a speed bump, not security. A determined student can get around it; the effort check is the real gate. The trade-off: blocking selection also breaks select-to-read tools (Read&Write, the browser's read-selected-text) and right-click spellcheck in the answer boxes. A teacher setting to turn it off may come later.
- Shared mode: questions are cached per reading. Per-student mode: each student's set is generated once and cached, and it isn't regenerated on retries.
- Shared mode: the question count stays the teacher's number. Deleting a question lowers it by 1 (never below 1), and publishing needs exactly that many questions. Changing a draft's text, grade, count, or mode clears its shared questions.
- Once published, only the title can be edited; the text, grade, question count, mode, and questions stay locked. This applies to both modes.
- Per-student mode: each reading allows at most 150 student question sets. Past that, a new student sees "Ask your teacher for help with this one." A student who already has a set keeps it.
- Changing a class's grade clears the shared questions of its draft readings that use the class grade (no reading override). Published readings and drafts with an override are untouched.
- Question generation is limited to 30 per teacher per 10 minutes (generate, regenerate, and previews). Students' own sets in per-student mode don't count toward it.
- Free plan: creating a 2nd class is blocked.
- Readings: the text must be 200 to 20,000 characters after cleanup (line endings, control characters, extra blank lines). A longer article is refused, never cut. Titles are up to 120 characters, links up to 2,048.
- Link fetching: limited to 20 per teacher per 10 minutes (pasted text isn't limited). We only fetch http/https links to public hosts, with 8 seconds and 2 MB per fetch, and only HTML pages.
- Joining: a student enters the class code, their first name (up to 30 letters; spaces, hyphens, and apostrophes are OK), and the first 1 or 2 letters of their last name. Nothing else is collected.
- A name already taken in the class (ignoring case and extra spaces) is refused with "Someone already has that name. Add another letter." It is never resumed: progress does not carry over by name.
- Joining needs the class code to be on. An unknown code and a code that's off get the same message. Students who already joined keep access when the code is turned off.
- Joining is rate limited to 60 tries per IP and 100 per code, each per 10 minutes. Every try counts, including a wrong code or a taken name. A bot check is planned (a placeholder for now).
- These limits are first estimates. A school behind one shared IP can hit 60 tries per IP if several classes join at once, and because the per-code key is the typed code, someone making about 100 junk tries on a real code can block joins to it for 10 minutes. Revisit them with the bot check in the abuse PR.
- IP addresses are stored only as a keyed hash (HMAC-SHA256 with a server secret), only for the join rate limit. Rows are deleted by the next join after the 10-minute window (so after a quiet period they can stay longer), and Neon's restore history keeps deleted rows for its restore window.
- A student's session is an httpOnly cookie that lasts 180 days. Only a hash of its token is stored. Joining a different class on the same device replaces the session.
- Student data is visible only to the owning teacher, and we store only first names plus last initials.

## AI calls
1. **Generate questions** (once per reading, or once per student in per-student mode): open-ended questions tied to specific details in the text, plus one "what do you think" question, written for the teacher-chosen grade level.
2. **Effort check** (per attempt): one call, given the text and every question with its answer, returns pass or fail per answer and a nudge on each fail. The bar is "did they try and engage with the text and the question," never quality, spelling, grammar, or correctness. Short but genuine answers and opinions pass; "idk", gibberish, a copy of the question, and off-topic answers fail. It writes for the reading's grade (the reading's own grade, else the class's), and treats the text and answers as data, never as instructions.
   - Nudges: at most 140 characters, kind and specific (what to look at or add), never giving away an answer, never shaming. Dashes are removed and longer nudges are shortened before a student sees them.

## Decided
- AI provider: **Claude** (Anthropic API) for both question generation and the effort check.
