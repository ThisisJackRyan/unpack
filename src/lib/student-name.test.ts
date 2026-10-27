import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeNamePart, studentNameKey } from "./student-name";

describe("studentNameKey", () => {
  it("ignores case and extra spaces", () => {
    assert.equal(studentNameKey("Maya", "Ro"), "maya ro");
    assert.equal(studentNameKey(" MAYA ", "ro "), "maya ro");
    assert.equal(studentNameKey("Mary   Ann", "Lo"), "mary ann lo");
  });

  it("keeps inner spaces, so two-word names stay distinct", () => {
    assert.notEqual(studentNameKey("Mary Ann", "Lo"), studentNameKey("Maryann", "Lo"));
  });

  it("treats every apostrophe the same", () => {
    for (const first of ["D'Andre", "D’Andre", "D‘Andre", "DʼAndre", "DʻAndre", "D＇Andre", "D`Andre"]) {
      assert.equal(studentNameKey(first, "Sm"), "d'andre sm", first);
    }
  });

  it("matches a combining accent to the composed letter", () => {
    assert.equal(studentNameKey("Zoé", "Ro"), studentNameKey("Zoé", "Ro"));
  });
});

describe("normalizeNamePart", () => {
  it("leaves hyphens alone", () => {
    assert.equal(normalizeNamePart(" Jean-Luc "), "jean-luc");
  });
});
