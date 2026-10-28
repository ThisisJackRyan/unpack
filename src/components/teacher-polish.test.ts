import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  actionButton,
  dangerActionButton,
  optionCard,
  optionRadio,
  primaryButton,
  quietButton,
  secondaryButton,
} from "./ui";

const src = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, src), "utf8");

// The tallest min-h-N in a class string, in px (Tailwind: N * 4px).
function minHeightPx(cls: string): number {
  const sizes = [...cls.matchAll(/(?:^|\s)min-h-(\d+)\b/g)].map((m) => Number(m[1]) * 4);
  return Math.max(0, ...sizes);
}

describe("C5 teacher reading page buttons", () => {
  const panel = read("app/teacher/classes/[id]/readings/[readingId]/questions-panel.tsx");
  const card = panel.slice(panel.indexOf("function QuestionCard"), panel.indexOf("function QuestionText"));

  test("Edit, Regenerate and Delete are at least 44px tall", () => {
    assert.ok(minHeightPx(actionButton) >= 44, actionButton);
    assert.ok(minHeightPx(dangerActionButton) >= 44, dangerActionButton);
  });

  test("the question card uses those classes, and only Delete is red", () => {
    const edit = card.slice(card.indexOf("id={`edit-"), card.indexOf("<EditIcon"));
    assert.match(edit, /className=\{actionButton\}/);
    const regenerate = card.slice(card.indexOf('intent="regenerate_one"'), card.indexOf("<RetryIcon"));
    assert.match(regenerate, /className=\{actionButton\}/);
    const del = card.slice(card.indexOf("<ConfirmButton"));
    assert.match(del, /className=\{dangerActionButton\}/);
    assert.equal(card.match(/dangerActionButton/g)?.length, 1);
    assert.ok(!actionButton.includes("danger"));
  });
});

describe("C5 teacher text matches the student side", () => {
  const files = [
    ...(readdirSync(new URL("app/teacher/", src), { recursive: true }) as string[])
      .filter((f) => /\.tsx$/.test(f))
      .map((f) => `app/teacher/${f}`),
    "components/teacher-answers.tsx",
    "components/reading-form.tsx",
  ];

  test("there are teacher files to check", () => {
    assert.ok(files.length > 15, String(files.length));
  });

  // The student pages use text-lg (18px) for body text, meta lines and
  // notices. Teacher text is the same; only compact badges, counters and
  // the join code chip stay at text-base (16px), like the student "sm" badge.
  test("no text below text-lg except badges and chips", () => {
    for (const f of files) {
      const lines = read(f).split("\n");
      lines.forEach((line, i) => {
        assert.doesNotMatch(line, /\btext-(xs|sm)\b|\btext-\[\d+(\.\d+)?(px|rem)\]/, `${f}:${i + 1}`);
        if (/\btext-base\b/.test(line)) {
          assert.match(line, /\$\{pill\}|rounded-full|font-mono/, `${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  });

  test("teacher body text is text-lg on the reading page and queue", () => {
    const page = read("app/teacher/classes/[id]/readings/[readingId]/page.tsx");
    assert.match(page, /<p className="text-lg text-ink-700">Removes it for everyone/);
    assert.match(page, /<dd className="text-lg font-semibold text-ink-950">/);
    const queue = read("app/teacher/classes/[id]/challenges/queue.tsx");
    assert.match(queue, /<p className="text-lg text-ink-700">\{noNoteHelp\(item\.studentName\)\}<\/p>/);
  });
});

describe("C5 reading form source choice", () => {
  const form = read("components/reading-form.tsx");
  const source = form.slice(form.indexOf("<legend className={`${label} mb-2`}>Source"), form.indexOf('id="source-error"'));
  const mode = form.slice(form.indexOf("Question mode</legend>"), form.indexOf('id="mode-error"'));

  test("each option is a card with a visible, real radio", () => {
    for (const block of [source, mode]) {
      assert.match(block, /className=\{`\$\{optionCard\}/);
      assert.match(block, /type="radio"/);
      assert.match(block, /className=\{(optionRadio|`\$\{optionRadio\} mt-1`)\}/);
      assert.doesNotMatch(block, /sr-only/);
    }
    // Wrapped in a fieldset with a legend: one named radio group.
    assert.match(form, /<fieldset key=\{`source-\$\{values\.source\}`\}/);
    assert.match(source, /name="source"/);
    assert.doesNotMatch(form, /\btrack\b/);
  });

  test("the card shows the selected state and the focus ring", () => {
    assert.match(optionCard, /\bhas-checked:border-primary-600\b/);
    assert.match(optionCard, /\bhas-checked:bg-primary-50\b/);
    assert.match(optionCard, /\bborder-ink-400\b/);
    assert.match(optionCard, /has-focus-visible:outline-3/);
    assert.ok(minHeightPx(optionCard) >= 44);
    assert.doesNotMatch(optionRadio, /sr-only|appearance-none|opacity-0/);
    assert.match(optionRadio, /\baccent-primary-600\b/);
    // The card picks one alignment; the shared class sets none.
    assert.doesNotMatch(optionCard, /\bitems-(start|center)\b/);
    assert.doesNotMatch(optionRadio, /\bmt-\d/);
  });
});

describe("C5 Save draft is the quieter action", () => {
  const form = read("components/reading-form.tsx");
  const footer = form.slice(form.indexOf("{teacherCreate ? ("));

  test("shared mode: a text style Save draft beside a solid Create & generate", () => {
    const save = footer.slice(0, footer.indexOf('"Save draft"'));
    assert.match(save, /type="submit"\s+name="then"\s+value="save"[\s\S]*className=\{`\$\{quietButton\} \$\{sharedOnly\}`\}/);
    const create = footer.slice(footer.indexOf('value="generate"'), footer.indexOf('"Create & generate"'));
    assert.match(create, /className=\{`\$\{primaryButton\} \$\{sharedOnly\}`\}/);
    assert.doesNotMatch(footer.slice(0, footer.indexOf('"Create & generate"')), /\$\{secondaryButton\} \$\{sharedOnly\}/);
  });

  test("the quiet button reads as a link but is still a 48px button", () => {
    assert.match(quietButton, /\bunderline\b/);
    assert.match(quietButton, /\btext-primary-700\b/);
    assert.doesNotMatch(quietButton, /\bborder\b|shadow-lip|\bbg-(white|primary-600)\b/);
    assert.ok(minHeightPx(quietButton) >= 44);
    assert.match(quietButton, /focus-visible:outline-3/);
    // Quieter than both neighbours.
    assert.match(primaryButton, /shadow-lip-primary/);
    assert.match(secondaryButton, /border-2/);
  });
});
