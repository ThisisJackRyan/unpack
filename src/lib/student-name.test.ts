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

  it("drops every apostrophe and the ʻokina", () => {
    for (const first of ["D'Andre", "D’Andre", "D‘Andre", "DʼAndre", "DʻAndre", "D＇Andre", "D`Andre", "D´Andre", "D′Andre", "DAndre"]) {
      assert.equal(studentNameKey(first, "Sm"), "dandre sm", first);
    }
    assert.equal(studentNameKey("Keʻala", "P"), studentNameKey("Keala", "P"));
    assert.equal(studentNameKey("ʻIolani", "K"), "iolani k");
    assert.equal(studentNameKey("'Iolani", "K"), studentNameKey("ʻIolani", "K"));
  });

  it("strips accents, composed or combining", () => {
    assert.equal(studentNameKey("Zoë", "Ro"), "zoe ro");
    assert.equal(studentNameKey("Zoë", "Ro"), "zoe ro");
    assert.equal(studentNameKey("José", "Ñu"), "jose nu");
    assert.equal(studentNameKey("Zoé", "Ro"), studentNameKey("Zoé", "Ro"));
  });

  it("folds hyphens to a space", () => {
    assert.equal(studentNameKey("Jean-Luc", "Pi"), studentNameKey("Jean Luc", "Pi"));
    assert.equal(studentNameKey("Jean–Luc", "Pi"), "jean luc pi");
  });

  it("case-folds beyond lowercase, and folds compatibility forms", () => {
    assert.equal(studentNameKey("Straße", "Ro"), studentNameKey("Strasse", "Ro"));
    assert.equal(studentNameKey("ＭＡＹＡ", "Ro"), "maya ro");
  });

  it("keeps the vowel signs other scripts need, and whole Hangul syllables", () => {
    assert.notEqual(studentNameKey("राम", "S"), studentNameKey("रम", "S"));
    assert.equal(studentNameKey("하나", "K"), "하나 k");
  });
});

describe("normalizeNamePart", () => {
  it("makes hyphens spaces and trims", () => {
    assert.equal(normalizeNamePart(" Jean-Luc "), "jean luc");
    assert.equal(normalizeNamePart("Mary - Ann"), "mary ann");
  });
});
