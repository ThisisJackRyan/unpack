import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReadingFormState } from "@/components/reading-form-state";
import { LONG_ARTICLE_HTML, LONG_ARTICLE_PARAGRAPHS } from "./__fixtures__/long-article";
import { guardCreate, readingSaveFailedState } from "./create-guard";
import { extractArticle } from "./fetch-article";
import { FetchArticleError } from "./fetch-errors";
import { SAVE_READING_FAILED_MESSAGE } from "./reading-source";
import { allowanceFor, type CreateOutcome, type SelfReadingDraft } from "./self-allowance";
import { createSelfReadingWith, type SelfCreateDeps, type SelfCreateResult } from "./self-reading-create";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_TOO_LONG_MESSAGE,
  readingFormValues,
  type ReadingFormInput,
} from "./validate-reading";

const ALLOWANCE = allowanceFor("free");
const BODY = "Bees dance to tell each other where the flowers are. ".repeat(6);

function textInput(over: Partial<ReadingFormInput> = {}): ReadingFormInput {
  return { source: "text", url: "", title: "  Bees  ", bodyText: BODY, gradeLevel: "5", questionCount: "4", questionMode: null, ...over };
}
function linkInput(): ReadingFormInput {
  return textInput({ source: "link", url: "https://example.com/bees", bodyText: "" });
}

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

// One account's database, as the create sees it: the self_readings rows
// (each one is a held slot) and the link_fetch_attempts rows. The create
// is one transaction: it adds its row and nothing else, or, when it
// fails, nothing at all (`failCreate`: the transaction errors, so Postgres
// rolls it back).
function fakeDb() {
  const db = {
    readings: [] as SelfReadingDraft[],
    linkFetches: 0,
    failCreate: false,
    remaining: () => ALLOWANCE.readings - db.readings.length,
  };
  const deps: SelfCreateDeps = {
    requireAccount: async () => ({ id: "account-1" }),
    getAllowance: async () => ({ remaining: db.remaining() }),
    recordLinkFetch: async () => {
      db.linkFetches += 1;
      return true;
    },
    linkLimitedMessage: async () => "limited",
    fetchArticle: async (url) => ({ title: "From the page", text: BODY, url, trimmed: false }),
    createSelfReading: async (_accountId, draft): Promise<CreateOutcome> => {
      if (db.failCreate) throw Object.assign(new Error("connection terminated"), { code: "57P01" });
      if (db.remaining() === 0) return { status: "limit_reached", state: { used: 5, remaining: 0, nextFreeAt: null } };
      db.readings.push(draft);
      return { status: "created", id: `reading-${db.readings.length}` };
    },
    log: () => {},
  };
  return { db, deps };
}

// As the action runs it: inside guardCreate, failing to the kept values.
function run(input: ReadingFormInput, deps: SelfCreateDeps, deadlineMs = 50): Promise<SelfCreateResult> {
  return keepingAlive(() =>
    guardCreate((preWrite) => createSelfReadingWith(input, preWrite, deps), () => ({ state: readingSaveFailedState(readingFormValues(input)) }), {
      rethrow: rethrowNext,
      onError: () => {},
      deadlineMs,
    }),
  );
}

function stateOf(result: SelfCreateResult): ReadingFormState {
  assert.ok("state" in result, `expected a form state, got ${JSON.stringify(result)}`);
  return result.state;
}

// The form's own values for what was typed: the text, title, level and
// count all come back. (The question mode isn't on this form.)
function assertKept(state: ReadingFormState, input: ReadingFormInput) {
  assert.deepEqual({ ...state.values, questionMode: "" }, { ...readingFormValues(input), questionMode: "" });
  assert.equal(state.values?.bodyText, input.bodyText);
  assert.equal(state.values?.title, "Bees");
  assert.equal(state.values?.gradeLevel, "5");
  assert.equal(state.values?.questionCount, "4");
}

describe("createSelfReadingWith: a failed create uses no weekly slot and no limiter count", () => {
  it("creates: one row (the slot), a replace redirect to the reading", async () => {
    const { db, deps } = fakeDb();
    const result = await run(textInput(), deps);
    assert.deepEqual(result, { redirect: { path: "/learn/r/reading-1", type: "replace" } });
    assert.equal(db.readings.length, 1);
    assert.equal(db.remaining(), ALLOWANCE.readings - 1);
    assert.equal(db.linkFetches, 0, "pasted text records no link fetch");
  });

  const beforeTheWrite: { name: string; over: (deps: SelfCreateDeps) => void }[] = [
    { name: "the account lookup throws (Neon, Clerk)", over: (d) => (d.requireAccount = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the account lookup passes the deadline", over: (d) => (d.requireAccount = never) },
    { name: "the allowance read throws", over: (d) => (d.getAllowance = async () => Promise.reject(new Error("fetch failed"))) },
    { name: "the allowance read passes the deadline", over: (d) => (d.getAllowance = never) },
  ];
  for (const { name, over } of beforeTheWrite) {
    it(`${name}: the form keeps everything, the allowance is unchanged`, async () => {
      for (const input of [textInput(), linkInput()]) {
        const { db, deps } = fakeDb();
        let created = 0;
        const create = deps.createSelfReading;
        deps.createSelfReading = (...args) => {
          created += 1;
          return create(...args);
        };
        over(deps);
        const state = stateOf(await run(input, deps));
        assert.equal(state.errors?.form, SAVE_READING_FAILED_MESSAGE);
        assert.deepEqual(state.values, readingFormValues(input));
        assert.equal(created, 0, "the create transaction never ran");
        assert.equal(db.readings.length, 0);
        assert.equal(db.remaining(), ALLOWANCE.readings, "no slot used");
        assert.equal(db.linkFetches, 0, "no link fetch recorded");
      }
    });
  }

  it("the create transaction fails: no row, the allowance unchanged, everything kept", async () => {
    const { db, deps } = fakeDb();
    db.failCreate = true;
    const input = textInput();
    const state = stateOf(await run(input, deps));
    assert.equal(state.errors?.form, SAVE_READING_FAILED_MESSAGE);
    assertKept(state, input);
    assert.equal(db.readings.length, 0);
    assert.equal(db.remaining(), ALLOWANCE.readings);
    // And the next try works, on the same slot.
    db.failCreate = false;
    assert.deepEqual(await run(input, deps), { redirect: { path: "/learn/r/reading-1", type: "replace" } });
    assert.equal(db.remaining(), ALLOWANCE.readings - 1);
  });

  it("a link: the fetch is recorded before the fetch (it limits fetches, not readings); a failed fetch uses no slot", async () => {
    const { db, deps } = fakeDb();
    const order: string[] = [];
    const record = deps.recordLinkFetch;
    deps.recordLinkFetch = async (id) => {
      order.push("record");
      return record(id);
    };
    deps.fetchArticle = async () => {
      order.push("fetch");
      throw new FetchArticleError("timeout");
    };
    const input = linkInput();
    const state = stateOf(await run(input, deps));
    assert.deepEqual(order, ["record", "fetch"]);
    assert.ok(state.errors?.url);
    assert.equal(state.values?.url, "https://example.com/bees");
    assert.equal(db.linkFetches, 1);
    assert.equal(db.readings.length, 0);
    assert.equal(db.remaining(), ALLOWANCE.readings);
  });

  it("a link whose create transaction fails: the fetch counted, no slot used", async () => {
    const { db, deps } = fakeDb();
    db.failCreate = true;
    const state = stateOf(await run(linkInput(), deps));
    assert.equal(state.errors?.form, SAVE_READING_FAILED_MESSAGE);
    assert.equal(db.linkFetches, 1);
    assert.equal(db.readings.length, 0);
  });

  it("the link limit's retry-time read passing the deadline doesn't fail the form: a relative time", async () => {
    const { db, deps } = fakeDb();
    deps.recordLinkFetch = async () => false;
    deps.linkLimitedMessage = never;
    const state = stateOf(await run(linkInput(), deps));
    assert.ok(state.limit && state.limit.length > 0);
    assert.equal(state.errors?.form, undefined);
    assert.equal(db.readings.length, 0);
  });

  it("at the allowance: back to /learn/new (a replace), no fetch recorded", async () => {
    const { db, deps } = fakeDb();
    for (let i = 0; i < ALLOWANCE.readings; i += 1) await run(textInput(), deps);
    assert.equal(db.remaining(), 0);
    const result = await run(linkInput(), deps);
    assert.deepEqual(result, { redirect: { path: "/learn/new", type: "replace" } });
    assert.equal(db.linkFetches, 0);
  });

  it("every redirect is a replace", async () => {
    const { deps } = fakeDb();
    const outcomes: CreateOutcome[] = [
      { status: "created", id: "r" },
      { status: "limit_reached", state: { used: 5, remaining: 0, nextFreeAt: null } },
      { status: "not_allowed" },
    ];
    for (const outcome of outcomes) {
      deps.createSelfReading = async () => outcome;
      const result = await run(textInput(), deps);
      assert.ok("redirect" in result && result.redirect.type === "replace", outcome.status);
    }
  });

  it("an invalid form: its errors and values, no lookup past the account, nothing written", async () => {
    const { db, deps } = fakeDb();
    let allowanceReads = 0;
    deps.getAllowance = async () => {
      allowanceReads += 1;
      return { remaining: 5 };
    };
    const state = stateOf(await run(textInput({ gradeLevel: "" }), deps));
    assert.ok(state.errors?.gradeLevel);
    assert.equal(state.values?.bodyText, BODY);
    assert.equal(allowanceReads, 0);
    assert.equal(db.readings.length, 0);
  });

  it("Next's redirect from the account lookup (signed out) still reaches Next", async () => {
    const { deps } = fakeDb();
    deps.requireAccount = async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
    };
    await assert.rejects(run(textInput(), deps), /NEXT_REDIRECT/);
  });
});

describe("createSelfReadingWith: a long linked article is trimmed, pasted text is not", () => {
  it("stores exactly the trimmed text, flagged, from a long article page", async () => {
    const { db, deps } = fakeDb();
    // The real extractor on a saved page (no network).
    let extracted = "";
    deps.fetchArticle = async (url) => {
      const article = extractArticle(LONG_ARTICLE_HTML, new URL(url));
      extracted = article.text;
      return { ...article, url };
    };
    const result = await run(linkInput(), deps, 1000);
    assert.deepEqual(result, { redirect: { path: "/learn/r/reading-1", type: "replace" } });
    assert.equal(db.readings.length, 1);
    const [saved] = db.readings;
    assert.equal(saved.bodyTrimmed, true);
    assert.equal(saved.bodyText, extracted);
    assert.ok(saved.bodyText.length <= BODY_TEXT_MAX_LENGTH);
    const kept = saved.bodyText.split("\n\n");
    assert.deepEqual(kept, LONG_ARTICLE_PARAGRAPHS.slice(0, kept.length));
    assert.ok(kept.length < LONG_ARTICLE_PARAGRAPHS.length);
  });

  it("stores a short article and pasted text unflagged", async () => {
    const linked = fakeDb();
    await run(linkInput(), linked.deps);
    assert.equal(linked.db.readings[0].bodyTrimmed, false);
    const pasted = fakeDb();
    await run(textInput(), pasted.deps);
    assert.equal(pasted.db.readings[0].bodyTrimmed, false);
  });

  it("still refuses pasted text over the limit, with the same message, using no slot", async () => {
    const { db, deps } = fakeDb();
    const long = textInput({ bodyText: "Pasted words go on and on. ".repeat(1000) });
    const state = stateOf(await run(long, deps));
    assert.deepEqual(state.errors, { bodyText: BODY_TEXT_TOO_LONG_MESSAGE });
    assert.equal(
      BODY_TEXT_TOO_LONG_MESSAGE,
      "This is too long. Keep it under 20,000 characters, or paste a shorter section.",
    );
    assert.equal(state.values?.bodyText, long.bodyText);
    assert.equal(db.readings.length, 0);
    assert.equal(db.linkFetches, 0);
  });
});
