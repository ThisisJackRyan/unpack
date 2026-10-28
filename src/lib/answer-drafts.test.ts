import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  ANSWER_DRAFT_PREFIX,
  browserDraftStorage,
  clearDrafts,
  clearNoteDraft,
  decodeDraft,
  DRAFT_TTL_DAYS,
  draftKey,
  encodeDraft,
  loadDrafts,
  loadNoteDraft,
  NOTE_DRAFT_PREFIX,
  noteDraftKey,
  pruneDrafts,
  saveDraft,
  saveNoteDraft,
  withDrafts,
  type DraftStorage,
} from "./answer-drafts";
import { ANSWER_MAX_LENGTH, CHALLENGE_NOTE_MAX_LENGTH } from "./validate-answers";

const READING = "00000000-0000-4000-8000-0000000000aa";
const STUDENT = "00000000-0000-4000-8000-0000000000bb";
const OTHER = "00000000-0000-4000-8000-0000000000cc";
const Q1 = "00000000-0000-4000-8000-000000000001";
const Q2 = "00000000-0000-4000-8000-000000000002";

const scope = (tryNumber: number, ownerId = STUDENT) => ({ mode: "class" as const, readingId: READING, ownerId, tryNumber });

// A Map-backed Storage.
function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

function throwingStorage(): DraftStorage {
  const fail = () => {
    throw new Error("QuotaExceededError");
  };
  return { length: 0, key: fail, getItem: fail, setItem: fail, removeItem: fail };
}

describe("draftKey", () => {
  it("holds ids only: mode, reading, owner, try, question", () => {
    assert.equal(draftKey(scope(2), Q1), `${ANSWER_DRAFT_PREFIX}class:${READING}:${STUDENT}:t2:${Q1}`);
    assert.equal(
      draftKey({ mode: "self", readingId: READING, ownerId: OTHER, tryNumber: 1 }, Q2),
      `unpack:answers:v1:self:${READING}:${OTHER}:t1:${Q2}`,
    );
  });
});

describe("saveDraft and loadDrafts", () => {
  it("round-trips this try's answer text only", () => {
    const s = memoryStorage();
    assert.equal(saveDraft(s, scope(1), Q1, "Bees make honey."), true);
    assert.deepEqual(loadDrafts(s, scope(1), [Q1, Q2]), { [Q1]: "Bees make honey." });
    // Another try or another student on the same device sees nothing.
    assert.deepEqual(loadDrafts(s, scope(2), [Q1, Q2]), {});
    assert.deepEqual(loadDrafts(s, scope(1, OTHER), [Q1, Q2]), {});
    // The stored value is the text and when it was saved, nothing else.
    const [stored] = [...s.map.values()];
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["savedAt", "text"]);
    assert.equal(decodeDraft(stored).text, "Bees make honey.");
  });

  it("keeps an emptied box as an empty draft", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "");
    assert.deepEqual(loadDrafts(s, scope(1), [Q1]), { [Q1]: "" });
  });

  it("caps a draft at the answer max length", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "a".repeat(ANSWER_MAX_LENGTH + 50));
    assert.equal(loadDrafts(s, scope(1), [Q1])[Q1].length, ANSWER_MAX_LENGTH);
  });

  it("tolerates a full, blocked or missing storage", () => {
    assert.equal(saveDraft(throwingStorage(), scope(1), Q1, "x"), false);
    assert.deepEqual(loadDrafts(throwingStorage(), scope(1), [Q1]), {});
    assert.equal(clearDrafts(throwingStorage(), scope(1)), 0);
    assert.equal(saveDraft(null, scope(1), Q1, "x"), false);
    assert.deepEqual(loadDrafts(null, scope(1), [Q1]), {});
    assert.equal(clearDrafts(null, scope(1)), 0);
  });

  it("finds no browser storage on the server", () => {
    assert.equal(browserDraftStorage(), null);
  });
});

describe("clearDrafts", () => {
  it("removes the owner's drafts on this reading, keeping one try if asked", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "old");
    saveDraft(s, scope(2), Q1, "new");
    saveDraft(s, scope(1, OTHER), Q1, "someone else");
    saveDraft(s, { ...scope(1), readingId: "00000000-0000-4000-8000-0000000000dd" }, Q1, "other reading");
    s.map.set("unrelated", "kept");

    assert.equal(clearDrafts(s, scope(2), 2), 1);
    assert.deepEqual(loadDrafts(s, scope(2), [Q1]), { [Q1]: "new" });
    assert.deepEqual(loadDrafts(s, scope(1), [Q1]), {});

    assert.equal(clearDrafts(s, scope(2)), 1);
    assert.deepEqual(loadDrafts(s, scope(2), [Q1]), {});
    assert.equal(s.map.size, 3);
    assert.equal(s.map.get("unrelated"), "kept");
  });
});

describe("withDrafts", () => {
  it("puts drafts over the prefill for editable questions only", () => {
    const prefill = { [Q1]: "last try", [Q2]: "last try 2" };
    assert.deepEqual(withDrafts(prefill, { [Q1]: "typed", [Q2]: "typed 2" }, [Q1]), { [Q1]: "typed", [Q2]: "last try 2" });
    assert.deepEqual(withDrafts(prefill, {}, [Q1, Q2]), prefill);
    assert.deepEqual(withDrafts(prefill, { [Q2]: "" }, [Q1, Q2]), { [Q1]: "last try", [Q2]: "" });
  });
});

// F5: the note to the teacher, kept like the answers.
describe("note drafts", () => {
  const owner = { mode: "class" as const, readingId: READING, ownerId: STUDENT };

  it("holds ids only in the key and the note text only in the value", () => {
    assert.equal(noteDraftKey(owner), `${NOTE_DRAFT_PREFIX}class:${READING}:${STUDENT}`);
    assert.equal(NOTE_DRAFT_PREFIX, "unpack:note:v1:");
  });

  it("round-trips, keeps a cleared note cleared, and is per student", () => {
    const s = memoryStorage();
    assert.equal(loadNoteDraft(s, owner), null);
    assert.equal(saveNoteDraft(s, owner, "I read it twice."), true);
    assert.equal(loadNoteDraft(s, owner), "I read it twice.");
    assert.equal(loadNoteDraft(s, { ...owner, ownerId: OTHER }), null);
    saveNoteDraft(s, owner, "");
    assert.equal(loadNoteDraft(s, owner), "");
    saveNoteDraft(s, owner, "x".repeat(CHALLENGE_NOTE_MAX_LENGTH + 20));
    assert.equal(loadNoteDraft(s, owner)?.length, CHALLENGE_NOTE_MAX_LENGTH);
  });

  it("survives clearing the answer drafts, and goes on clearNoteDraft", () => {
    const s = memoryStorage();
    saveDraft(s, scope(3), Q1, "idk");
    saveNoteDraft(s, owner, "Please look.");
    assert.equal(clearDrafts(s, owner), 1);
    assert.equal(loadNoteDraft(s, owner), "Please look.");
    clearNoteDraft(s, owner);
    assert.equal(loadNoteDraft(s, owner), null);
    assert.equal(s.map.size, 0);
  });

  it("tolerates missing or throwing storage", () => {
    assert.equal(saveNoteDraft(null, owner, "a"), false);
    assert.equal(loadNoteDraft(null, owner), null);
    assert.equal(saveNoteDraft(throwingStorage(), owner, "a"), false);
    assert.equal(loadNoteDraft(throwingStorage(), owner), null);
    clearNoteDraft(throwingStorage(), owner);
    clearNoteDraft(null, owner);
  });

  it("the note form restores, saves on every change, and clears after a send", () => {
    const source = readFileSync(new URL("../app/c/r/[readingId]/challenge-form.tsx", import.meta.url), "utf8");
    assert.match(source, /pruneDrafts\(storage\);\n    const saved = loadNoteDraft\(storage,/);
    assert.match(source, /saveNoteDraft\(browserDraftStorage\(\)/);
    assert.match(source, /if \(!next\.error\) clearNoteDraft\(/);
    const page = readFileSync(new URL("../app/c/r/[readingId]/page.tsx", import.meta.url), "utf8");
    assert.match(page, /keepNote=\{stage\.kind === "out_of_tries" \|\| stage\.kind === "check_limit"\}/);
  });
});

// N1 (PR 16 review): drafts expire after DRAFT_TTL_DAYS.
describe("draft expiry", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 9, 1, 12);
  const owner = { mode: "class" as const, readingId: READING, ownerId: STUDENT };

  it("is 7 days", () => {
    assert.equal(DRAFT_TTL_DAYS, 7);
  });

  it("an answer or note draft older than 7 days loads as absent; at 7 days it still loads", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "Bees make honey.", T0);
    saveNoteDraft(s, owner, "Please look.", T0);
    assert.deepEqual(loadDrafts(s, scope(1), [Q1], T0 + 7 * DAY), { [Q1]: "Bees make honey." });
    assert.equal(loadNoteDraft(s, owner, T0 + 7 * DAY), "Please look.");
    assert.deepEqual(loadDrafts(s, scope(1), [Q1], T0 + 7 * DAY + 1), {});
    assert.equal(loadNoteDraft(s, owner, T0 + 7 * DAY + 1), null);
  });

  it("saving again restarts the clock", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "first", T0);
    saveDraft(s, scope(1), Q1, "second", T0 + 6 * DAY);
    assert.deepEqual(loadDrafts(s, scope(1), [Q1], T0 + 10 * DAY), { [Q1]: "second" });
  });

  it("pruneDrafts removes expired answer and note drafts of every reading and owner, and nothing else", () => {
    const s = memoryStorage();
    saveDraft(s, scope(1), Q1, "old", T0);
    saveDraft(s, scope(2, OTHER), Q2, "old too", T0);
    saveNoteDraft(s, { ...owner, readingId: OTHER }, "old note", T0);
    saveDraft(s, scope(1), Q2, "fresh", T0 + 5 * DAY);
    saveNoteDraft(s, owner, "fresh note", T0 + 5 * DAY);
    s.setItem("someone:else", "kept");
    assert.equal(pruneDrafts(s, T0 + 8 * DAY), 3);
    assert.deepEqual(
      [...s.map.keys()].sort(),
      [draftKey(scope(1), Q2), noteDraftKey(owner), "someone:else"].sort(),
    );
  });

  it("an earlier-format draft (bare text, no time) loads as fresh, and the prune stamps it so it expires 7 days later", () => {
    const s = memoryStorage();
    s.setItem(draftKey(scope(1), Q1), "typed before the change");
    s.setItem(noteDraftKey(owner), "old note");
    assert.deepEqual(loadDrafts(s, scope(1), [Q1], T0), { [Q1]: "typed before the change" });
    assert.equal(loadNoteDraft(s, owner, T0), "old note");
    assert.equal(pruneDrafts(s, T0), 0);
    assert.deepEqual(decodeDraft(s.getItem(draftKey(scope(1), Q1)) ?? ""), { text: "typed before the change", savedAt: T0 });
    assert.equal(loadNoteDraft(s, owner, T0 + 7 * DAY), "old note");
    assert.equal(pruneDrafts(s, T0 + 7 * DAY + 1), 2);
    assert.equal(s.map.size, 0);
  });

  it("text that only looks like JSON is still text", () => {
    assert.deepEqual(decodeDraft("{not json"), { text: "{not json", savedAt: null });
    assert.deepEqual(decodeDraft('{"text":"x"}'), { text: '{"text":"x"}', savedAt: null });
    assert.deepEqual(decodeDraft(encodeDraft("{a}", T0)), { text: "{a}", savedAt: T0 });
  });

  it("tolerates missing or throwing storage", () => {
    assert.equal(pruneDrafts(null), 0);
    assert.equal(pruneDrafts(throwingStorage()), 0);
  });

  it("both forms prune before they restore", () => {
    const form = readFileSync(new URL("../components/answer-form.tsx", import.meta.url), "utf8");
    assert.match(form, /pruneDrafts\(storage\);\n    clearDrafts\(storage, owner, tryNumber\);/);
  });
});
