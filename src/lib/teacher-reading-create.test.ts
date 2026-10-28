import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LONG_ARTICLE_HTML, LONG_ARTICLE_PARAGRAPHS } from "./__fixtures__/long-article";
import { STRIP_FALLBACK_HTML, STRIP_FALLBACK_TEXT_MARKER, STRIP_FALLBACK_TITLE } from "./__fixtures__/strip-fallback";
import { logStripFallback } from "./strip-fallback-log";
import { guardCreate, readingSaveFailedState } from "./create-guard";
import { extractArticle } from "./fetch-article";
import { SAVE_READING_FAILED_MESSAGE } from "./reading-source";
import type { ReadingDraft } from "./readings";
import { CLASS_NOT_FOUND_MESSAGE, createTeacherReadingWith, type TeacherCreateDeps, type TeacherCreateResult } from "./teacher-reading-create";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_TOO_LONG_MESSAGE,
  readingFormValues,
  type ReadingFormInput,
} from "./validate-reading";

const BODY = "The river carried the boat past the mill and into town. ".repeat(5);
const input: ReadingFormInput = {
  source: "text",
  url: "",
  title: "The river",
  bodyText: BODY,
  gradeLevel: "",
  questionCount: "3",
  questionMode: "per_student",
};
const never = <T>() => new Promise<T>(() => {});

// AbortSignal.timeout's timer doesn't keep Node's event loop alive (it is
// unref'd), so a test waiting only on it would end early.
async function keepingAlive<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}
const rethrowNext = (error: unknown) => {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
};

function fakeDb() {
  const db = { readings: [] as ReadingDraft[], linkFetches: 0, failInsert: false };
  const deps: TeacherCreateDeps = {
    requireTeacher: async () => ({ id: "teacher-1" }),
    ownsClass: async () => true,
    recordLinkFetch: async () => {
      db.linkFetches += 1;
      return true;
    },
    linkLimitedMessage: async () => "limited",
    fetchArticle: async (url) => ({ title: "Page", text: BODY, url, trimmed: false }),
    insertReading: async (_classId, _teacherId, draft) => {
      if (db.failInsert) throw new Error("fetch failed");
      db.readings.push(draft);
      return { id: `reading-${db.readings.length}` };
    },
    log: () => {},
    logStripFallback: () => assert.fail("no strip fallback"),
  };
  return { db, deps };
}

function run(deps: TeacherCreateDeps, deadlineMs = 50, form: ReadingFormInput = input): Promise<TeacherCreateResult> {
  return keepingAlive(() =>
    guardCreate(
      (preWrite) => createTeacherReadingWith("class-1", form, preWrite, deps),
      () => ({ state: readingSaveFailedState(readingFormValues(form)) }),
      { rethrow: rethrowNext, onError: () => {}, deadlineMs },
    ),
  );
}

describe("createTeacherReadingWith: a failed create writes no reading", () => {
  it("creates one reading", async () => {
    const { db, deps } = fakeDb();
    const result = await run(deps);
    assert.ok("readingId" in result && result.readingId === "reading-1" && result.draft.questionMode === "per_student");
    assert.equal(db.readings.length, 1);
  });

  const failures: { name: string; over: (deps: TeacherCreateDeps, db: ReturnType<typeof fakeDb>["db"]) => void }[] = [
    { name: "the teacher lookup throws", over: (d) => (d.requireTeacher = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the teacher lookup passes the deadline", over: (d) => (d.requireTeacher = never) },
    { name: "the class ownership check throws", over: (d) => (d.ownsClass = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the class ownership check passes the deadline", over: (d) => (d.ownsClass = never) },
    { name: "the insert fails", over: (_d, db) => (db.failInsert = true) },
  ];
  for (const { name, over } of failures) {
    it(`${name}: SAVE_READING_FAILED_MESSAGE, every value kept, no reading`, async () => {
      const { db, deps } = fakeDb();
      over(deps, db);
      const result = await run(deps);
      assert.ok("state" in result);
      assert.equal(result.state.errors?.form, SAVE_READING_FAILED_MESSAGE);
      assert.deepEqual(result.state.values, readingFormValues(input));
      assert.equal(db.readings.length, 0);
      assert.equal(db.linkFetches, 0);
    });
  }

  it("not this teacher's class: the class message, no reading", async () => {
    const { db, deps } = fakeDb();
    deps.ownsClass = async () => false;
    const result = await run(deps);
    assert.ok("state" in result && result.state.errors?.form === CLASS_NOT_FOUND_MESSAGE);
    assert.equal(result.state.values?.bodyText, BODY);
    assert.equal(db.readings.length, 0);
  });
});

describe("createTeacherReadingWith: a long linked article is trimmed, pasted text is not", () => {
  const link: ReadingFormInput = { ...input, source: "link", url: "https://example.com/river", title: "", bodyText: "" };

  it("stores exactly the trimmed text, flagged, from a long article page", async () => {
    const { db, deps } = fakeDb();
    // The real extractor on a saved page (no network).
    let extracted = "";
    deps.fetchArticle = async (url) => {
      const article = extractArticle(LONG_ARTICLE_HTML, new URL(url));
      extracted = article.text;
      return { ...article, url };
    };
    const result = await run(deps, 1000, link);
    assert.ok("readingId" in result, JSON.stringify(result));
    assert.equal(db.readings.length, 1);
    const [saved] = db.readings;
    assert.equal(saved.bodyTrimmed, true);
    assert.equal(saved.bodyText, extracted);
    assert.ok(saved.bodyText.length <= BODY_TEXT_MAX_LENGTH);
    const kept = saved.bodyText.split("\n\n");
    assert.deepEqual(kept, LONG_ARTICLE_PARAGRAPHS.slice(0, kept.length));
    assert.ok(kept.length < LONG_ARTICLE_PARAGRAPHS.length);
    assert.equal(saved.title, "A very long river story");
    assert.equal(saved.sourceUrl, "https://example.com/river");
  });

  it("stores a short article and pasted text unflagged", async () => {
    const linked = fakeDb();
    await run(linked.deps, 50, link);
    assert.equal(linked.db.readings[0].bodyTrimmed, false);
    const pasted = fakeDb();
    await run(pasted.deps);
    assert.equal(pasted.db.readings[0].bodyTrimmed, false);
  });

  it("still refuses pasted text over the limit, with the same message", async () => {
    const { db, deps } = fakeDb();
    const long = { ...input, bodyText: "Pasted words go on and on. ".repeat(1000) };
    const result = await run(deps, 50, long);
    assert.ok("state" in result);
    assert.deepEqual(result.state.errors, { bodyText: BODY_TEXT_TOO_LONG_MESSAGE });
    assert.equal(
      BODY_TEXT_TOO_LONG_MESSAGE,
      "This is too long. Keep it under 20,000 characters, or paste a shorter section.",
    );
    assert.equal(result.state.values?.bodyText, long.bodyText);
    assert.equal(db.readings.length, 0);
    assert.equal(db.linkFetches, 0);
  });
});

// What the fallback's log line may never hold: any part of the link, the
// title, or the text.
function assertNoPageData(line: string, url: string) {
  const link = new URL(url);
  for (const part of [url, link.host, link.hostname, link.pathname, "kelp-forests", STRIP_FALLBACK_TITLE, "FALLBACK_TITLE", STRIP_FALLBACK_TEXT_MARKER, "Kelp"]) {
    assert.equal(line.includes(part), false, part);
  }
}

describe("createTeacherReadingWith: the strip fallback's log line", () => {
  const url = "https://fallback-host.example.org/oceans/kelp-forests?ref=SECRET_QUERY";
  const link: ReadingFormInput = { ...input, source: "link", url, title: "", bodyText: "" };

  function withFallbackPage() {
    const { db, deps } = fakeDb();
    const lines: string[] = [];
    const errors: unknown[] = [];
    // The real extractor on a saved page (no network), and the real log
    // line, written to a list.
    deps.fetchArticle = async (fetched) => ({ ...extractArticle(STRIP_FALLBACK_HTML, new URL(fetched)), url: fetched });
    deps.logStripFallback = (fields) => logStripFallback(fields, (line) => lines.push(line));
    deps.log = (...args) => errors.push(args);
    return { db, deps, lines, errors };
  }

  it("logs one info line with only the reason, the path, and the new reading's id", async () => {
    const { db, deps, lines, errors } = withFallbackPage();
    const result = await run(deps, 50, link);
    assert.ok("readingId" in result);
    assert.equal(db.readings.length, 1);
    assert.match(db.readings[0].bodyText, new RegExp(STRIP_FALLBACK_TEXT_MARKER));
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      event: "reading.strip_fallback",
      reason: "much_shorter",
      path: "class",
      readingId: result.readingId,
    });
    assertNoPageData(lines[0], url);
    assert.deepEqual(errors, []);
  });

  it("still logs it once, without an id, when the insert fails", async () => {
    const { db, deps, lines } = withFallbackPage();
    db.failInsert = true;
    const result = await run(deps, 50, link);
    assert.ok("state" in result);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { event: "reading.strip_fallback", reason: "much_shorter", path: "class" });
    assertNoPageData(lines[0], url);
  });
});
