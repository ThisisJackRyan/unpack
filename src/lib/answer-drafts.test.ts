import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANSWER_DRAFT_PREFIX,
  browserDraftStorage,
  clearDrafts,
  draftKey,
  loadDrafts,
  saveDraft,
  withDrafts,
  type DraftStorage,
} from "./answer-drafts";
import { ANSWER_MAX_LENGTH } from "./validate-answers";

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
    // The stored value is the text, nothing else.
    assert.deepEqual([...s.map.values()], ["Bees make honey."]);
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
