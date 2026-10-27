import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BODY_TEXT_MAX_LENGTH,
  BODY_TEXT_MIN_LENGTH,
  cutTitle,
  normalizeBodyText,
  normalizeTitle,
  parseSourceUrl,
  READING_TITLE_MAX_LENGTH,
  resolveLinkTitle,
  sourceHost,
  validateReadingForm,
} from "./validate-reading";

const TEXT = "Octopuses change color with tiny sacs of pigment. ".repeat(6);

function form(overrides: Record<string, unknown> = {}) {
  return {
    source: "text",
    url: "",
    title: "Octopus skin",
    bodyText: TEXT,
    gradeLevel: "",
    questionCount: "3",
    questionMode: "shared",
    ...overrides,
  };
}

function errorsOf(input: Record<string, unknown>) {
  const result = validateReadingForm(form(input));
  assert.equal(result.ok, false);
  return !result.ok ? result.errors : {};
}

describe("normalizeBodyText", () => {
  it("turns CRLF and CR into LF", () => {
    assert.equal(normalizeBodyText("a\r\nb\rc"), "a\nb\nc");
  });

  it("collapses 3 or more newlines to a blank line", () => {
    assert.equal(normalizeBodyText("a\n\n\n\nb\n\nc\nd"), "a\n\nb\n\nc\nd");
  });

  it("treats lines of only spaces as blank", () => {
    assert.equal(normalizeBodyText("a  \n \t \n   \nb"), "a\n\nb");
  });

  it("removes NUL and other control characters but keeps tab and newline", () => {
    assert.equal(
      normalizeBodyText("a\u0000b\u0007c\u001bd\u007fe\u0085f\tg\nh"),
      "abcdef\tg\nh",
    );
  });

  it("turns Unicode line and paragraph separators into newlines", () => {
    assert.equal(normalizeBodyText("a\u2028b\u2029c"), "a\nb\nc");
  });

  it("trims the whole text", () => {
    assert.equal(normalizeBodyText("\n\n  hello  \n\n"), "hello");
  });

  it("keeps leading indentation inside the text", () => {
    assert.equal(normalizeBodyText("a\n  b"), "a\n  b");
  });
});

describe("titles", () => {
  it("normalizeTitle makes one trimmed line", () => {
    assert.equal(normalizeTitle("  How\n Octopuses\t\u0000Change  "), "How Octopuses Change");
  });

  it("cutTitle leaves short titles alone", () => {
    assert.equal(cutTitle("  Short title "), "Short title");
    const exact = "a".repeat(READING_TITLE_MAX_LENGTH);
    assert.equal(cutTitle(exact), exact);
  });

  it("cutTitle shortens at a word break with an ellipsis", () => {
    const long = "word ".repeat(40);
    const cut = cutTitle(long);
    assert.ok(cut.length <= READING_TITLE_MAX_LENGTH);
    assert.ok(cut.endsWith("word…"));
  });

  it("cutTitle shortens a title with no spaces", () => {
    const cut = cutTitle("x".repeat(300));
    assert.equal(cut.length, READING_TITLE_MAX_LENGTH);
    assert.ok(cut.endsWith("…"));
  });

  it("cutTitle never leaves half an emoji", () => {
    const cut = cutTitle(`${"x".repeat(READING_TITLE_MAX_LENGTH - 2)}😀😀😀`);
    assert.ok(cut.length <= READING_TITLE_MAX_LENGTH);
    assert.doesNotMatch(cut, /[\uD800-\uDBFF]…$/);
  });

  it("resolveLinkTitle prefers the typed title", () => {
    assert.equal(resolveLinkTitle(" Mine ", "From page"), "Mine");
  });

  it("resolveLinkTitle falls back to the page title, trimmed and cut", () => {
    assert.equal(resolveLinkTitle("", "  From   page "), "From page");
    const cut = resolveLinkTitle("   ", "word ".repeat(60));
    assert.ok(cut && cut.length <= READING_TITLE_MAX_LENGTH);
  });

  it("resolveLinkTitle is undefined when neither has text", () => {
    assert.equal(resolveLinkTitle("", ""), undefined);
    assert.equal(resolveLinkTitle(" ", null), undefined);
    assert.equal(resolveLinkTitle("", " \n "), undefined);
  });
});

describe("parseSourceUrl", () => {
  it("accepts http and https links", () => {
    assert.equal(parseSourceUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
    assert.equal(parseSourceUrl(" http://example.com "), "http://example.com/");
  });

  it("adds https:// when there is no scheme", () => {
    assert.equal(parseSourceUrl("example.com/story"), "https://example.com/story");
  });

  it("rejects other schemes and junk", () => {
    for (const input of [
      "",
      "   ",
      "ftp://example.com/a",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "https://",
      "http://exa mple.com",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      assert.equal(parseSourceUrl(input), undefined, input);
    }
  });
});

describe("validateReadingForm: text mode", () => {
  it("accepts a title and text and normalizes them", () => {
    const result = validateReadingForm(
      form({ title: "  Octopus \n skin ", bodyText: `\r\n${TEXT}\r\n\r\n\r\nEnd.  ` }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.data, {
      source: "text",
      title: "Octopus skin",
      bodyText: `${TEXT.trim()}\n\nEnd.`,
      gradeLevel: null,
      questionCount: 3,
      questionMode: "shared",
    });
  });

  it("requires a title", () => {
    assert.deepEqual(errorsOf({ title: "  " }), { title: "Enter a title." });
  });

  it("limits the title length", () => {
    const atLimit = "t".repeat(READING_TITLE_MAX_LENGTH);
    assert.equal(validateReadingForm(form({ title: atLimit })).ok, true);
    assert.deepEqual(errorsOf({ title: `${atLimit}t` }), {
      title: `Keep the title to ${READING_TITLE_MAX_LENGTH} characters or less.`,
    });
  });

  it("requires text", () => {
    assert.deepEqual(errorsOf({ bodyText: " \n " }), {
      bodyText: "Paste the text of the reading.",
    });
    assert.deepEqual(errorsOf({ bodyText: null }), {
      bodyText: "Paste the text of the reading.",
    });
  });

  it("needs at least the minimum length after normalizing", () => {
    const atMin = "a".repeat(BODY_TEXT_MIN_LENGTH);
    assert.equal(validateReadingForm(form({ bodyText: `  ${atMin}  ` })).ok, true);
    assert.deepEqual(
      errorsOf({ bodyText: `\u0000${"a".repeat(BODY_TEXT_MIN_LENGTH - 1)}\n\n` }),
      { bodyText: `This is too short. Paste at least ${BODY_TEXT_MIN_LENGTH} characters.` },
    );
  });

  it("allows up to the maximum length and no more", () => {
    const atMax = "a".repeat(BODY_TEXT_MAX_LENGTH);
    assert.equal(validateReadingForm(form({ bodyText: atMax })).ok, true);
    assert.deepEqual(errorsOf({ bodyText: `${atMax}a` }), {
      bodyText:
        "This is too long. Keep it under 20,000 characters, or paste a shorter section.",
    });
  });

  it("counts length after collapsing blank lines", () => {
    const padded = `${"a".repeat(BODY_TEXT_MAX_LENGTH - 3)}\n\n\n\n\n\nb`;
    assert.equal(validateReadingForm(form({ bodyText: padded })).ok, true);
  });

  it("ignores the link field", () => {
    const result = validateReadingForm(form({ url: "not a url" }));
    assert.equal(result.ok, true);
  });
});

describe("validateReadingForm: link mode", () => {
  const link = { source: "link", url: "https://example.com/octopus", title: "", bodyText: "" };

  it("accepts a link with no title", () => {
    const result = validateReadingForm(form(link));
    assert.deepEqual(result.ok && result.data, {
      source: "link",
      url: "https://example.com/octopus",
      title: "",
      gradeLevel: null,
      questionCount: 3,
      questionMode: "shared",
    });
  });

  it("keeps a typed title", () => {
    const result = validateReadingForm(form({ ...link, title: " My title " }));
    assert.equal(result.ok && result.data.title, "My title");
  });

  it("still limits a typed title", () => {
    assert.deepEqual(errorsOf({ ...link, title: "t".repeat(READING_TITLE_MAX_LENGTH + 1) }), {
      title: `Keep the title to ${READING_TITLE_MAX_LENGTH} characters or less.`,
    });
  });

  it("requires a link", () => {
    assert.deepEqual(errorsOf({ ...link, url: " " }), {
      url: "Paste a link to the reading.",
    });
  });

  it("rejects a link that isn't a web link", () => {
    assert.deepEqual(errorsOf({ ...link, url: "ftp://example.com/a" }), {
      url: "Enter a full web link, like https://example.com/story.",
    });
  });

  it("adds https:// to a bare host", () => {
    const result = validateReadingForm(form({ ...link, url: "example.com/a" }));
    assert.equal(result.ok && result.data.source === "link" && result.data.url, "https://example.com/a");
  });

  it("ignores the text box, even when it is invalid", () => {
    const result = validateReadingForm(form({ ...link, bodyText: "short" }));
    assert.equal(result.ok, true);
    assert.equal(result.ok && "bodyText" in result.data, false);
  });
});

describe("validateReadingForm: settings", () => {
  it("requires a known source", () => {
    for (const source of ["", "file", null]) {
      assert.deepEqual(errorsOf({ source }), { source: "Choose a link or text." });
    }
  });

  it("treats an empty grade as the class grade", () => {
    const result = validateReadingForm(form({ gradeLevel: "" }));
    assert.equal(result.ok && result.data.gradeLevel, null);
  });

  it("accepts a grade override", () => {
    for (const gradeLevel of ["K", "2", "12", "adult"]) {
      const result = validateReadingForm(form({ gradeLevel }));
      assert.equal(result.ok && result.data.gradeLevel, gradeLevel);
    }
  });

  it("rejects an unknown grade", () => {
    for (const gradeLevel of ["13", "Grade 4", "k"]) {
      assert.deepEqual(errorsOf({ gradeLevel }), { gradeLevel: "Choose a grade level." });
    }
  });

  it("accepts 1 to 10 questions", () => {
    for (let n = 1; n <= 10; n++) {
      const result = validateReadingForm(form({ questionCount: String(n) }));
      assert.equal(result.ok && result.data.questionCount, n);
    }
  });

  it("rejects other question counts", () => {
    for (const questionCount of ["0", "11", "-1", "3.5", "", "three", " 3", "003", null]) {
      assert.deepEqual(errorsOf({ questionCount }), {
        questionCount: "Choose 1 to 10 questions.",
      });
    }
  });

  it("accepts both question modes", () => {
    for (const questionMode of ["shared", "per_student"]) {
      const result = validateReadingForm(form({ questionMode }));
      assert.equal(result.ok && result.data.questionMode, questionMode);
    }
  });

  it("rejects an unknown question mode", () => {
    for (const questionMode of ["", "unique", null]) {
      assert.deepEqual(errorsOf({ questionMode }), {
        questionMode: "Choose how questions are made.",
      });
    }
  });

  it("reports every error and echoes the input", () => {
    const result = validateReadingForm({
      source: "text",
      url: " x ",
      title: " ",
      bodyText: "hi",
      gradeLevel: "13",
      questionCount: "11",
      questionMode: "x",
    });
    assert.deepEqual(result, {
      ok: false,
      errors: {
        title: "Enter a title.",
        bodyText: "This is too short. Paste at least 200 characters.",
        gradeLevel: "Choose a grade level.",
        questionCount: "Choose 1 to 10 questions.",
        questionMode: "Choose how questions are made.",
      },
      values: {
        source: "text",
        url: "x",
        title: "",
        bodyText: "hi",
        gradeLevel: "13",
        questionCount: "11",
        questionMode: "x",
      },
    });
  });
});

describe("sourceHost", () => {
  it("shows the host without www.", () => {
    assert.equal(sourceHost("https://www.example.com/a?b=1"), "example.com");
    assert.equal(sourceHost("http://news.example.co.uk:8080/"), "news.example.co.uk");
  });

  it("is undefined for missing or bad links", () => {
    assert.equal(sourceHost(null), undefined);
    assert.equal(sourceHost(""), undefined);
    assert.equal(sourceHost("not a url"), undefined);
  });
});
