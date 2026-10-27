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
8. Turn a join code on or off.

**Student (no account)**
1. Enter the class code, their **first name, and the first 1–2 letters of their last name** (for example "Maya Ro"). This creates a browser session, and progress is tied to that session, not to the name.
   - If that name is already taken in the class, the student is asked to add another letter.
   - A student on a new device starts fresh. Progress does **not** carry over by name.
2. See the class's published readings.
3. Read in a clean view with copy and paste blocked.
4. Answer the questions and submit. The AI returns pass or fail per answer, with a short nudge on each fail.
5. Up to 3 tries. After the 3rd fail, they can submit a challenge note to the teacher.
6. Passed readings are marked done.

**Later (not v1):** saved reading libraries (paid), unlimited classes (paid), billing, the self-learner extension, and export to Google Classroom.

## Data model (Postgres / Neon)

| Table | Key fields |
|---|---|
| teachers | id, clerk_user_id, name, email, plan (free/paid), created_at |
| classes | id, teacher_id, name, grade_level, join_code (unique), code_active, created_at |
| readings | id, class_id, title, source_url, body_text, grade_level (overrides the class; optional), question_count, question_mode (shared/per_student), status (draft/published), created_at |
| questions | id, reading_id, student_id (null when shared), position, prompt, created_at |
| students | id, class_id, first_name, last_initials, session_token, created_at. first_name + last_initials is unique within each class. |
| attempts | id, student_id, reading_id, try_number (1–3), result (pass/fail), created_at |
| answers | id, attempt_id, question_id, text, ai_pass (bool), ai_feedback |
| challenges | id, student_id, reading_id, note, status (open/approved/denied), resolved_at |

Student status for a reading is derived from attempts and challenges: Passed if any attempt passed or a challenge was approved, Challenged if a challenge is open, and so on.

## Key rules
- An attempt passes only when **every** answer passes the effort check.
- Try 4 is blocked; only the challenge option appears.
- Shared mode: questions are cached per reading. Per-student mode: each student's set is generated once and cached, and it isn't regenerated on retries.
- Free plan: creating a 2nd class is blocked.
- Readings: the text must be 200 to 20,000 characters after cleanup (line endings, control characters, extra blank lines). A longer article is refused, never cut. Titles are up to 120 characters, links up to 2,048.
- Link fetching: limited to 20 per teacher per 10 minutes (pasted text isn't limited). We only fetch http/https links to public hosts, with 8 seconds and 2 MB per fetch, and only HTML pages.
- Joining a class is rate limited per IP and per code, with a bot check.
- Student data is visible only to the owning teacher, and we store only first names plus last initials.

## AI calls
1. **Generate questions** (once per reading, or once per student in per-student mode): open-ended questions tied to specific details in the text, plus one "what do you think" question, written for the teacher-chosen grade level.
2. **Effort check** (per attempt): given the text, a question, and an answer, return pass or fail and a one-line nudge. The bar is "did they try and engage with the text," not correctness.

## Decided
- AI provider: **Claude** (Anthropic API) for both question generation and the effort check.
